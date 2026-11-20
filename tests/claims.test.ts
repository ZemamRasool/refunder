// The full money flow: receipts → rules find money → approve → letter → sent → won → fee.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Stripe from "stripe";
import { as, buildApp, fakeParser, ok, onboard, prisma, resetDb, uploadText } from "./helpers.js";
import { createStripeProvider } from "../src/services/payments.js";
import { purgeRawData } from "../src/services/retention.js";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const SARA = "sara@example.com";

/** Two identical charges for the same order → a strong duplicate-charge finding. */
async function withDuplicate() {
  const ctx = buildApp({ parser: fakeParser(ok({ order_id: "A1", total_amount: 48 })).parser });
  await uploadText(ctx.app, SARA, "first charge");
  await uploadText(ctx.app, SARA, "second charge");
  await ctx.worker.drain();
  const list = await request(ctx.app).get("/api/claims").set(as(SARA)).expect(200);
  return { ...ctx, list: list.body, claimId: list.body.claims[0]?.id as string };
}

describe("finding money", () => {
  it("finds a duplicate charge and shows 'you may be owed'", async () => {
    const { list } = await withDuplicate();
    expect(list.claims).toHaveLength(1);
    expect(list.claims[0]).toMatchObject({ type: "duplicate_charge", status: "found", expectedAmount: 48, currency: "GBP" });
    expect(list.claims[0].reason).toMatch(/twice/);
    expect(list.totals.owed).toEqual({ GBP: 48 });
  });

  it("does not create the same finding again, and a dismissed one stays dismissed", async () => {
    const { app, worker, claimId } = await withDuplicate();
    await request(app).post(`/api/claims/${claimId}/dismiss`).set(as(SARA)).expect(200);
    await request(app).post("/api/claims/scan").set(as(SARA)).expect(202);
    await worker.drain();
    const list = await request(app).get("/api/claims").set(as(SARA));
    expect(list.body.claims).toHaveLength(1);
    expect(list.body.claims[0].status).toBe("dismissed");
  });

  it("asks what happened to a flight, then works out the amount", async () => {
    const flight = { airline: "British Airways", flight_number: "BA117", departure_airport: "LHR", arrival_airport: "JFK", scheduled_departure: "2026-10-01T11:20:00Z" };
    const { app, worker } = buildApp({
      parser: fakeParser(ok({ merchant: "British Airways", total_amount: 612, category: "flight", document_type: "booking_confirmation", order_id: "XKQ7PL", flight })).parser,
    });
    await uploadText(app, SARA, "booking");
    await worker.drain();
    const list = await request(app).get("/api/claims").set(as(SARA));
    const claim = list.body.claims[0];
    expect(claim).toMatchObject({ type: "flight_compensation", needsInput: "flight_outcome", expectedAmount: null, currency: "GBP" });

    // Can't approve before answering.
    await onboard(app, SARA);
    await request(app).post(`/api/claims/${claim.id}/approve`).set(as(SARA)).send({}).expect(400);

    const res = await request(app).post(`/api/claims/${claim.id}/flight-outcome`).set(as(SARA)).send({ outcome: "delayed", arrivalDelayMinutes: 320 }).expect(200);
    expect(res.body).toMatchObject({ expectedAmount: 520, needsInput: null, status: "found" });

    const approved = await request(app).post(`/api/claims/${claim.id}/approve`).set(as(SARA)).send({}).expect(200);
    expect(approved.body.letterSubject).toMatch(/UK261 compensation claim — flight BA117/);
    expect(approved.body.letterText).toContain("£520.00");
    expect(approved.body.letterText).toContain("5 hour(s) 20 minute(s) late");
    expect(approved.body.letterText).toContain("XKQ7PL");
  });

  it("dismisses a flight that was on time", async () => {
    const flight = { airline: "BA", flight_number: "BA117", departure_airport: "LHR", arrival_airport: "JFK", scheduled_departure: "2026-10-01T11:20:00Z" };
    const { app, worker } = buildApp({ parser: fakeParser(ok({ category: "flight", document_type: "booking_confirmation", flight })).parser });
    await uploadText(app, SARA, "booking");
    await worker.drain();
    const claim = (await request(app).get("/api/claims").set(as(SARA))).body.claims[0];
    const res = await request(app).post(`/api/claims/${claim.id}/flight-outcome`).set(as(SARA)).send({ outcome: "on_time" }).expect(200);
    expect(res.body.status).toBe("dismissed");
  });
});

describe("claim tracker", () => {
  it("requires the fee agreement before approving", async () => {
    const { app, claimId } = await withDuplicate();
    await request(app).post(`/api/claims/${claimId}/approve`).set(as(SARA)).send({}).expect(403);
  });

  it("keeps people in launch countries only", async () => {
    const { app } = buildApp();
    await request(app).post("/api/me/onboarding").set(as(SARA)).send({ country: "PK", acceptTerms: true }).expect(422);
    expect(await prisma.waitlistSignup.findUnique({ where: { email: SARA } })).toMatchObject({ country: "PK" });
    await request(app).post("/api/me/onboarding").set(as(SARA)).send({ country: "GB", acceptTerms: false }).expect(400);
  });

  it("goes found → approved → sent → won, and charges a 25% fee", async () => {
    const { app, claimId } = await withDuplicate();
    await onboard(app, SARA);

    const approved = await request(app).post(`/api/claims/${claimId}/approve`).set(as(SARA)).send({}).expect(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.letterText).toContain("£48.00");
    expect(approved.body.letterText).toContain("A1");

    const edited = await request(app)
      .patch(`/api/claims/${claimId}/letter`)
      .set(as(SARA))
      .send({ subject: "Double charge", body: "Hello, you charged me £48.00 twice for order A1. Please refund one." })
      .expect(200);
    expect(edited.body.letterSubject).toBe("Double charge");

    // Can't jump straight to lost from approved, or approve twice.
    await request(app).post(`/api/claims/${claimId}/lost`).set(as(SARA)).expect(409);
    await request(app).post(`/api/claims/${claimId}/approve`).set(as(SARA)).send({}).expect(409);

    await request(app).post(`/api/claims/${claimId}/sent`).set(as(SARA)).expect(200);
    // Letter is locked once sent.
    await request(app).patch(`/api/claims/${claimId}/letter`).set(as(SARA)).send({ subject: "xxx", body: "x".repeat(30) }).expect(409);

    const won = await request(app).post(`/api/claims/${claimId}/won`).set(as(SARA)).send({ recoveredAmount: 48 }).expect(200);
    expect(won.body).toMatchObject({ status: "won", recoveredAmount: 48 });

    const billing = await request(app).get("/api/billing").set(as(SARA)).expect(200);
    expect(billing.body.fees[0]).toMatchObject({ status: "pending", feePercent: 25, feeAmount: 12, currency: "GBP" });

    const rule = await prisma.claimRule.findUnique({ where: { code: "duplicate_charge" } });
    expect(rule!.successRate).toBe(1);

    const totals = (await request(app).get("/api/claims").set(as(SARA))).body.totals;
    expect(totals.recovered).toEqual({ GBP: 48 });
  });

  it("never lets another user touch someone's claim", async () => {
    const { app, claimId } = await withDuplicate();
    await onboard(app, "omar@example.com");
    await request(app).get(`/api/claims/${claimId}`).set(as("omar@example.com")).expect(404);
    await request(app).post(`/api/claims/${claimId}/approve`).set(as("omar@example.com")).send({}).expect(404);
    await request(app).post(`/api/claims/${claimId}/dismiss`).set(as("omar@example.com")).expect(404);
    expect((await request(app).get("/api/claims").set(as("omar@example.com"))).body.claims).toEqual([]);
  });
});

describe("admin dashboard", () => {
  it("is closed to normal users, and the attempt is logged", async () => {
    const { app } = buildApp();
    await request(app).get("/api/admin/overview").set(as(SARA)).expect(403);
    expect(await prisma.auditLog.count({ where: { action: "admin.denied", actorEmail: SARA } })).toBe(1);
  });

  it("shows numbers, lets the admin mark a fee paid, and logs it", async () => {
    const { app, claimId } = await withDuplicate();
    await onboard(app, SARA);
    await request(app).post(`/api/claims/${claimId}/approve`).set(as(SARA)).send({}).expect(200);
    await request(app).post(`/api/claims/${claimId}/won`).set(as(SARA)).send({ recoveredAmount: 48 }).expect(200);

    const BOSS = as("boss@example.com");
    const overview = await request(app).get("/api/admin/overview").set(BOSS).expect(200);
    expect(overview.body).toMatchObject({ users: 2, claims: { won: 1 }, recovered: { GBP: 48 }, feesOutstanding: { GBP: 12 } });

    const payouts = await request(app).get("/api/admin/payouts").set(BOSS).expect(200);
    await request(app).post(`/api/admin/payouts/${payouts.body[0].id}/mark-paid`).set(BOSS).expect(200);
    await request(app).post(`/api/admin/payouts/${payouts.body[0].id}/mark-paid`).set(BOSS).expect(409);
    const after = await request(app).get("/api/admin/overview").set(BOSS);
    expect(after.body.feesPaid).toEqual({ GBP: 12 });

    const audit = await request(app).get("/api/admin/audit").set(BOSS).expect(200);
    expect(audit.body.map((a: { action: string }) => a.action)).toContain("admin.payout_mark-paid");
  });

  it("can switch off a weak rule so it stops finding claims", async () => {
    const { app, worker } = buildApp({ parser: fakeParser(ok({ order_id: "A1" })).parser });
    const BOSS = as("boss@example.com");
    const rules = await request(app).get("/api/admin/rules").set(BOSS).expect(200);
    const dup = rules.body.find((r: { code: string }) => r.code === "duplicate_charge");
    await request(app).patch(`/api/admin/rules/${dup.id}`).set(BOSS).send({ active: false }).expect(200);
    await uploadText(app, SARA, "one");
    await uploadText(app, SARA, "two");
    await worker.drain();
    expect((await request(app).get("/api/claims").set(as(SARA))).body.claims).toEqual([]);
  });
});

describe("account controls", () => {
  it("exports my data and deletes my account completely", async () => {
    const { app } = await withDuplicate();
    const exp = await request(app).get("/api/me/export").set(as(SARA)).expect(200);
    expect(exp.body.receipts).toHaveLength(2);
    expect(exp.body.claims).toHaveLength(1);

    await request(app).delete("/api/me").set(as(SARA)).send({}).expect(400);
    await request(app).delete("/api/me").set(as(SARA)).send({ confirm: "DELETE" }).expect(200);
    expect(await prisma.receipt.count()).toBe(0);
    expect(await prisma.claim.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "user.delete_account" } })).toBe(1);
  });

  it("blocks deletion while a fee is unpaid", async () => {
    const { app, claimId } = await withDuplicate();
    await onboard(app, SARA);
    await request(app).post(`/api/claims/${claimId}/approve`).set(as(SARA)).send({}).expect(200);
    await request(app).post(`/api/claims/${claimId}/won`).set(as(SARA)).send({ recoveredAmount: 48 }).expect(200);
    await request(app).delete("/api/me").set(as(SARA)).send({ confirm: "DELETE" }).expect(409);
  });

  it("removes raw receipt data after 30 days but keeps the extracted fields", async () => {
    const { app, worker, services } = buildApp();
    await uploadText(app, SARA, "old receipt text");
    await worker.drain();
    const in31Days = new Date(Date.now() + 31 * 86_400_000);
    expect(await purgeRawData(prisma, services.storage, 30, in31Days)).toBe(1);
    const r = await prisma.receipt.findFirst();
    expect(r).toMatchObject({ rawText: null, rawFileUrl: null, merchant: "Amazon", status: "parsed" });
  });
});

describe("Stripe webhook", () => {
  const secret = "whsec_test_secret";
  const stripe = new Stripe("sk_test_dummy");

  it("rejects unsigned or wrongly signed calls", async () => {
    const payments = createStripeProvider(prisma, { secretKey: "sk_test_dummy", webhookSecret: secret, baseUrl: "http://localhost" });
    const { app } = buildApp({ payments });
    await request(app).post("/webhooks/stripe").set("Content-Type", "application/json").send("{}").expect(400);
    await request(app).post("/webhooks/stripe").set("Content-Type", "application/json").set("Stripe-Signature", "t=1,v1=bad").send("{}").expect(400);
  });

  it("marks a fee paid when Stripe confirms the payment", async () => {
    const { app, claimId } = await withDuplicate();
    await onboard(app, SARA);
    await request(app).post(`/api/claims/${claimId}/approve`).set(as(SARA)).send({}).expect(200);
    await request(app).post(`/api/claims/${claimId}/won`).set(as(SARA)).send({ recoveredAmount: 48 }).expect(200);
    const payout = (await prisma.payout.findFirst())!;

    const payments = createStripeProvider(prisma, { secretKey: "sk_test_dummy", webhookSecret: secret, baseUrl: "http://localhost" });
    const stripeApp = buildApp({ payments }).app;
    const payload = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_123", object: "payment_intent", metadata: { payoutId: payout.id } } },
    });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    await request(stripeApp).post("/webhooks/stripe").set("Content-Type", "application/json").set("Stripe-Signature", header).send(payload).expect(200);
    expect(await prisma.payout.findUnique({ where: { id: payout.id } })).toMatchObject({ status: "paid", providerRef: "pi_123" });
  });
});
