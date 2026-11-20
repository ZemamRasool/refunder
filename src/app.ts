// Builds the web app: security headers, rate limits, API routes and the pages in /public.
// Everything it needs is passed in, so tests can swap the AI, login and payments for fakes.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Config } from "./config.js";
import type { Db } from "./lib/prisma.js";
import { Encryptor } from "./lib/crypto.js";
import type { AuthBackend } from "./auth/verifyToken.js";
import { requireAdmin, requireAuth } from "./middleware/requireAuth.js";
import { waitlistRouter } from "./routes/waitlist.js";
import { meRouter } from "./routes/me.js";
import { receiptsRouter } from "./routes/receipts.js";
import { inboundEmailRouter } from "./routes/inboundEmail.js";
import { claimsRouter } from "./routes/claims.js";
import { billingRouter, stripeWebhookRouter } from "./routes/billing.js";
import { adminRouter } from "./routes/admin.js";
import { FileStorage } from "./services/storage.js";
import { ReceiptProcessor } from "./services/receiptProcessor.js";
import { ClaimService } from "./services/claims.js";
import type { ReceiptParser } from "./services/receiptParser.js";
import type { LetterWriter } from "./services/letterWriter.js";
import type { PaymentProvider } from "./services/payments.js";

export interface AppDeps {
  config: Config;
  prisma: Db;
  auth: AuthBackend;
  parseReceipt: ReceiptParser;
  writeLetter: LetterWriter;
  payments: PaymentProvider;
}

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Builds the shared services once; used by the web app and by the worker. */
export function createServices({ config, prisma, parseReceipt, writeLetter, payments }: Omit<AppDeps, "auth">) {
  const crypto = new Encryptor(config.ENCRYPTION_KEY);
  const storage = new FileStorage(config.UPLOAD_DIR, crypto);
  const processor = new ReceiptProcessor(prisma, storage, crypto, parseReceipt);
  const claims = new ClaimService(prisma, writeLetter, payments, config);
  return { crypto, storage, processor, claims };
}

export function createApp(deps: AppDeps) {
  const { config, prisma, auth, payments } = deps;
  const { storage, processor, claims } = createServices(deps);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // Security headers. The Content Security Policy only allows our own scripts plus Firebase login.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://www.gstatic.com", "https://apis.google.com"],
          connectSrc: ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com"],
          frameSrc: ["https://*.firebaseapp.com", "https://accounts.google.com"],
          imgSrc: ["'self'", "data:"],
          styleSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null,
        },
      },
      // Firebase's Google sign-in popup needs to talk back to this window.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      hsts: config.NODE_ENV === "production",
    }),
  );

  // Rate limits: stop brute force, spam signups and runaway AI costs.
  const limiter = (windowMinutes: number, limit: number, byUser = false) =>
    rateLimit({
      windowMs: windowMinutes * 60_000,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => (byUser && req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? "")),
      message: { error: "Too many requests. Please wait a little and try again." },
    });

  const auth_ = requireAuth(prisma, auth);

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Public settings the browser needs to show the Firebase login.
  app.get("/api/config", (_req, res) => {
    res.json({
      authMode: config.AUTH_MODE,
      firebase: { apiKey: config.FIREBASE_WEB_API_KEY, authDomain: config.FIREBASE_WEB_AUTH_DOMAIN, projectId: config.FIREBASE_PROJECT_ID },
      launchCountries: config.LAUNCH_COUNTRIES,
      feePercent: config.FEE_PERCENT,
    });
  });

  // Webhooks come from other services, so they are mounted before the normal JSON parser.
  app.use(
    "/webhooks/inbound-email",
    limiter(1, 120),
    express.json({ limit: `${Math.ceil(config.MAX_UPLOAD_MB * 1.4 * 3)}mb` }),
    inboundEmailRouter(prisma, processor, { token: config.INBOUND_WEBHOOK_TOKEN, domain: config.INBOUND_EMAIL_DOMAIN, maxUploadMb: config.MAX_UPLOAD_MB }),
  );
  // Stripe signs the exact raw bytes, so this one must not be parsed as JSON first.
  app.use("/webhooks/stripe", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhookRouter(payments));

  app.use("/api", limiter(15, 600), express.json({ limit: "200kb" }));
  app.use("/api/waitlist", limiter(60, 10), waitlistRouter(prisma));
  app.use("/api/me", auth_, meRouter(prisma, config, storage, auth));
  app.use("/api/receipts", auth_, limiter(60, 100, true), receiptsRouter(prisma, processor, config.MAX_UPLOAD_MB));
  app.use("/api/claims", auth_, claimsRouter(prisma, claims));
  app.use("/api/billing", auth_, billingRouter(prisma, payments));
  app.use("/api/admin", auth_, requireAdmin(prisma, config.ADMIN_EMAILS), adminRouter(prisma, claims));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  app.use(express.static(publicDir, { extensions: ["html"] }));

  // Last stop for unexpected errors: log on the server, show a short message to the user.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
    if (e?.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
