// Builds the app with a fake AI, fake letter writer and manual payments, plus a worker
// to run background jobs on demand. Wipes the test database between tests.
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createApp, createServices } from "../src/app.js";
import { createPrisma } from "../src/lib/prisma.js";
import { createAuthBackend } from "../src/auth/verifyToken.js";
import { createHandlers } from "../src/jobs/handlers.js";
import { Worker } from "../src/jobs/queue.js";
import { ensureDefaultRules } from "../src/rules/defaultRules.js";
import { createManualProvider, type PaymentProvider } from "../src/services/payments.js";
import { fillTemplate, type LetterWriter } from "../src/services/letterWriter.js";
import type { ParseResult, ReceiptInput, ReceiptParser } from "../src/services/receiptParser.js";
import type { ParsedReceipt } from "../src/services/receiptSchema.js";

export const config = loadConfig();
export const prisma = createPrisma(config.DATABASE_URL);

export const sampleReceipt: ParsedReceipt = {
  is_receipt: true,
  merchant: "Amazon",
  total_amount: 64.99,
  currency: "GBP",
  purchase_date: "2026-10-02",
  order_id: "112-7781234-5550001",
  category: "shopping",
  document_type: "payment_receipt",
  is_recurring: false,
  items: [{ name: "USB-C charger", quantity: 1, unit_price: 64.99, total: 64.99 }],
  flight: null,
};

/** A fake AI reader. Give it one result, or a list used in order (last one repeats). */
export function fakeParser(results: ParseResult | ParseResult[] = { ok: true, receipt: sampleReceipt }) {
  const list = Array.isArray(results) ? results : [results];
  const calls: ReceiptInput[] = [];
  const parser: ReceiptParser = async (input) => {
    calls.push(input);
    return list[Math.min(calls.length - 1, list.length - 1)];
  };
  return { parser, calls };
}

export const ok = (overrides: Partial<ParsedReceipt> = {}): ParseResult => ({ ok: true, receipt: { ...sampleReceipt, ...overrides } });

export const fakeLetterWriter: LetterWriter = async (req) => ({ ...fillTemplate(req.templateText, req.values), usedAi: false });

export function buildApp(opts: { parser?: ReceiptParser; payments?: PaymentProvider; writeLetter?: LetterWriter } = {}) {
  const deps = {
    config,
    prisma,
    auth: createAuthBackend(config),
    parseReceipt: opts.parser ?? fakeParser().parser,
    writeLetter: opts.writeLetter ?? fakeLetterWriter,
    payments: opts.payments ?? createManualProvider(),
  };
  const app = createApp(deps);
  const services = createServices(deps);
  const worker = new Worker(prisma, createHandlers(prisma, services.processor), () => undefined);
  return { app, worker, services };
}

export const as = (email: string) => ({ Authorization: `Bearer dev:${email}` });

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    "TRUNCATE payouts, claims, claim_rules, receipts, users, waitlist_signups, jobs, audit_logs RESTART IDENTITY CASCADE",
  );
  await ensureDefaultRules(prisma);
}

/** Upload a small text "receipt" (unique content each time) as this user. */
let counter = 0;
export function uploadText(app: Parameters<typeof request>[0], email: string, text = `receipt ${++counter} ${Date.now()}`) {
  return request(app)
    .post("/api/receipts")
    .set(as(email))
    .attach("file", Buffer.from(text), { filename: "r.txt", contentType: "text/plain" });
}

export async function onboard(app: Parameters<typeof request>[0], email: string) {
  return request(app).post("/api/me/onboarding").set(as(email)).send({ country: "GB", acceptTerms: true }).expect(200);
}
