// Receipts in: upload, email webhook, background reading, privacy between users.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { as, buildApp, fakeParser, ok, prisma, resetDb, uploadText } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f80f00000101000518d84e0000000049454e44ae426082", "hex");

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("waitlist", () => {
  it("saves an email once, even if submitted twice", async () => {
    const { app } = buildApp();
    await request(app).post("/api/waitlist").send({ email: "Ali@Example.com" }).expect(201);
    await request(app).post("/api/waitlist").send({ email: "ali@example.com" }).expect(201);
    expect(await prisma.waitlistSignup.count()).toBe(1);
  });

  it("rejects a bad email and rate-limits spam", async () => {
    const { app } = buildApp();
    await request(app).post("/api/waitlist").send({ email: "nope" }).expect(400);
    for (let i = 0; i < 9; i++) await request(app).post("/api/waitlist").send({ email: `a${i}@x.com` });
    await request(app).post("/api/waitlist").send({ email: "late@x.com" }).expect(429);
  });
});

describe("security headers", () => {
  it("sends a strict content security policy and no framing", async () => {
    const res = await request(buildApp().app).get("/").expect(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("login and forwarding address", () => {
  it("blocks requests without a login", async () => {
    const { app } = buildApp();
    for (const path of ["/api/me", "/api/receipts", "/api/claims", "/api/billing", "/api/admin/overview"]) {
      await request(app).get(path).expect(401);
    }
  });

  it("creates the user on first login with a private address, and keeps it", async () => {
    const { app } = buildApp();
    const first = await request(app).get("/api/me").set(as("sara@example.com")).expect(200);
    expect(first.body.forwardingAddress).toMatch(/^[a-z0-9]{10}@in\.test\.local$/);
    expect(first.body.onboarded).toBe(false);
    const second = await request(app).get("/api/me").set(as("sara@example.com")).expect(200);
    expect(second.body.forwardingAddress).toBe(first.body.forwardingAddress);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("receipt upload", () => {
  it("saves at once, reads in the background, and stores the checked fields", async () => {
    const { parser, calls } = fakeParser();
    const { app, worker } = buildApp({ parser });
    const res = await request(app)
      .post("/api/receipts")
      .set(as("sara@example.com"))
      .attach("file", PNG, { filename: "r.png", contentType: "image/png" })
      .expect(202);
    expect(res.body.status).toBe("pending");
    expect(calls).toHaveLength(0); // not read yet: the website did not wait for the AI

    await worker.drain();
    expect(calls[0].kind).toBe("image");
    const one = await request(app).get(`/api/receipts/${res.body.id}`).set(as("sara@example.com")).expect(200);
    expect(one.body).toMatchObject({ status: "parsed", merchant: "Amazon", amount: 64.99, currency: "GBP", purchaseDate: "2026-10-02" });
    expect(one.body.parsed.items).toHaveLength(1);
    expect(one.body).not.toHaveProperty("rawFileUrl");
  });

  it("stores email text encrypted in the database", async () => {
    const { app } = buildApp();
    const res = await uploadText(app, "sara@example.com", "Your order 42, total £10.00");
    const row = await prisma.receipt.findUnique({ where: { id: res.body.id } });
    expect(row!.rawText).not.toContain("order 42");
  });

  it("does not count the same receipt twice", async () => {
    const { app } = buildApp();
    await uploadText(app, "sara@example.com", "same receipt").expect(202);
    const again = await uploadText(app, "sara@example.com", "same receipt").expect(200);
    expect(again.body.duplicate).toBe(true);
    expect(await prisma.receipt.count()).toBe(1);
  });

  it("marks the receipt failed (and saves nothing wrong) when the AI answer is invalid", async () => {
    const { app, worker } = buildApp({ parser: fakeParser({ ok: false, error: "AI answer failed validation: total_amount: bad" }).parser });
    const res = await uploadText(app, "sara@example.com");
    await worker.drain();
    const one = await request(app).get(`/api/receipts/${res.body.id}`).set(as("sara@example.com")).expect(200);
    expect(one.body).toMatchObject({ status: "failed", merchant: null, amount: null });
  });

  it("retries when the AI is temporarily unavailable, then succeeds", async () => {
    const { parser, calls } = fakeParser([{ ok: false, error: "AI busy", retryable: true }, ok()]);
    const { app, worker } = buildApp({ parser });
    const res = await uploadText(app, "sara@example.com");
    await worker.drain();
    expect(calls).toHaveLength(1);
    // Make the retry due now instead of in 30 seconds.
    await prisma.job.updateMany({ where: { status: "queued" }, data: { runAt: new Date(Date.now() - 1000) } });
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect((await prisma.receipt.findUnique({ where: { id: res.body.id } }))!.status).toBe("parsed");
  });

  it("refuses files that are not receipts, whatever their name says", async () => {
    await request(buildApp().app)
      .post("/api/receipts")
      .set(as("sara@example.com"))
      .attach("file", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]), { filename: "receipt.pdf", contentType: "application/pdf" })
      .expect(415);
  });

  it("never shows one customer's receipts to another", async () => {
    const { app } = buildApp();
    const up = await uploadText(app, "sara@example.com").expect(202);
    const other = await request(app).get("/api/receipts").set(as("omar@example.com")).expect(200);
    expect(other.body).toEqual([]);
    await request(app).get(`/api/receipts/${up.body.id}`).set(as("omar@example.com")).expect(404);
    await request(app).get(`/api/receipts/${up.body.id}`).set(as("sara@example.com")).expect(200);
  });
});

describe("inbound email webhook", () => {
  async function userAddress(app: ReturnType<typeof buildApp>["app"]) {
    const me = await request(app).get("/api/me").set(as("sara@example.com"));
    return me.body.forwardingAddress as string;
  }
  const url = "/webhooks/inbound-email?token=test-webhook-token-123456789";

  it("rejects calls without the secret token", async () => {
    const { app } = buildApp();
    await request(app).post("/webhooks/inbound-email").send({}).expect(401);
    await request(app).post("/webhooks/inbound-email?token=wrong").send({}).expect(401);
  });

  it("files a forwarded email under the right user", async () => {
    const { parser, calls } = fakeParser(ok({ merchant: "Uber" }));
    const { app, worker } = buildApp({ parser });
    const to = await userAddress(app);
    await request(app)
      .post(url)
      .send({ To: `"Sara" <${to}>`, From: "receipts@uber.com", Subject: "Your trip", HtmlBody: "<p>Total <b>£12.40</b></p>" })
      .expect(200, { ok: true, receipts: 1 });
    await worker.drain();
    expect(calls[0]).toMatchObject({ kind: "text" });
    const list = await request(app).get("/api/receipts").set(as("sara@example.com"));
    expect(list.body[0]).toMatchObject({ source: "email", merchant: "Uber", status: "parsed" });
  });

  it("reads PDF attachments", async () => {
    const { parser, calls } = fakeParser();
    const { app, worker } = buildApp({ parser });
    const to = await userAddress(app);
    await request(app)
      .post(url)
      .send({ To: to, TextBody: "see attached", Attachments: [{ Name: "inv.pdf", ContentType: "application/pdf", Content: Buffer.from("%PDF-1.4 test").toString("base64") }] })
      .expect(200, { ok: true, receipts: 1 });
    await worker.drain();
    expect(calls[0].kind).toBe("pdf");
  });

  it("ignores emails to unknown addresses", async () => {
    const res = await request(buildApp().app).post(url).send({ To: "zzzzzzzzzz@in.test.local", TextBody: "hi" }).expect(200);
    expect(res.body.ignored).toBeDefined();
    expect(await prisma.receipt.count()).toBe(0);
  });

  it("stops accepting mail at an old address after the user rotates it", async () => {
    const { app } = buildApp();
    const oldAddress = await userAddress(app);
    const rotated = await request(app).post("/api/me/rotate-address").set(as("sara@example.com")).expect(200);
    expect(rotated.body.forwardingAddress).not.toBe(oldAddress);
    const res = await request(app).post(url).send({ To: oldAddress, TextBody: "receipt" }).expect(200);
    expect(res.body.ignored).toBe("unknown address");
  });
});
