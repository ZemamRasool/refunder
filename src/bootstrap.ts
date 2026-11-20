// Wires the real pieces together (database, Firebase, Gemini, payments).
// Used by server.ts (website) and worker.ts (background jobs).
import { loadConfig } from "./config.js";
import { createPrisma } from "./lib/prisma.js";
import { createAuthBackend } from "./auth/verifyToken.js";
import { createGeminiReceiptParser } from "./services/receiptParser.js";
import { createGeminiLetterWriter } from "./services/letterWriter.js";
import { createManualProvider, createStripeProvider } from "./services/payments.js";
import { createHandlers } from "./jobs/handlers.js";
import { Worker } from "./jobs/queue.js";
import { createServices } from "./app.js";
import { ensureDefaultRules } from "./rules/defaultRules.js";
import { purgeRawData } from "./services/retention.js";

export async function bootstrap() {
  const config = loadConfig();
  const prisma = createPrisma(config.DATABASE_URL);
  const payments =
    config.PAYMENT_PROVIDER === "stripe"
      ? createStripeProvider(prisma, { secretKey: config.STRIPE_SECRET_KEY, webhookSecret: config.STRIPE_WEBHOOK_SECRET, baseUrl: config.PUBLIC_BASE_URL })
      : createManualProvider();
  const deps = {
    config,
    prisma,
    auth: createAuthBackend(config),
    parseReceipt: createGeminiReceiptParser(config.GEMINI_API_KEY, config.GEMINI_MODEL),
    writeLetter: createGeminiLetterWriter(config.GEMINI_API_KEY, config.GEMINI_MODEL),
    payments,
  };
  const services = createServices(deps);
  await ensureDefaultRules(prisma);

  const worker = new Worker(prisma, createHandlers(prisma, services.processor));

  // Daily: delete raw receipt files and email text older than RAW_RETENTION_DAYS.
  const purge = async () => {
    const n = await purgeRawData(prisma, services.storage, config.RAW_RETENTION_DAYS).catch((e) => {
      console.error("retention purge failed", e);
      return 0;
    });
    if (n) console.log(`Removed raw data from ${n} receipt(s) older than ${config.RAW_RETENTION_DAYS} days`);
  };

  return { config, prisma, deps, services, worker, purge };
}
