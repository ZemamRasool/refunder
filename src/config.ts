// Reads settings from environment variables (.env) and checks them once at startup.
// If something required is missing or unsafe, the server refuses to start with a clear message.
import "dotenv/config";
import { z } from "zod";

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    // 32 random bytes as 64 hex characters. Encrypts receipt files and email text at rest.
    ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 random bytes)"),

    GEMINI_API_KEY: z.string().default(""),
    GEMINI_MODEL: z.string().default("gemini-3.5-flash"),

    AUTH_MODE: z.enum(["firebase", "dev"]).default("firebase"),
    FIREBASE_PROJECT_ID: z.string().default(""),
    FIREBASE_CLIENT_EMAIL: z.string().default(""),
    FIREBASE_PRIVATE_KEY: z.string().default(""),
    FIREBASE_WEB_API_KEY: z.string().default(""),
    FIREBASE_WEB_AUTH_DOMAIN: z.string().default(""),

    // Emails (comma-separated) that can open the admin dashboard.
    ADMIN_EMAILS: z.string().default("").transform((v) => csv(v).map((e) => e.toLowerCase())),

    // Countries we accept customers from (ISO codes). Start with one (SPEC.md).
    LAUNCH_COUNTRIES: z.string().default("GB").transform((v) => csv(v).map((c) => c.toUpperCase())),

    INBOUND_EMAIL_DOMAIN: z.string().default("in.refundradar.app"),
    INBOUND_WEBHOOK_TOKEN: z.string().default(""),

    UPLOAD_DIR: z.string().default("./uploads"),
    MAX_UPLOAD_MB: z.coerce.number().positive().max(25).default(10),
    RAW_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

    // Our share of recovered money (SPEC.md: 20–30%).
    FEE_PERCENT: z.coerce.number().min(20).max(30).default(25),
    TERMS_VERSION: z.string().default("2026-11-04"),

    // "manual" = admin records fee payments by hand (works from Pakistan today).
    // "stripe" = card on file, charged automatically after a win (needs a Stripe account, e.g. via Stripe Atlas).
    PAYMENT_PROVIDER: z.enum(["manual", "stripe"]).default("manual"),
    STRIPE_SECRET_KEY: z.string().default(""),
    STRIPE_WEBHOOK_SECRET: z.string().default(""),

    // Run the background worker inside the web server (simple setups). Set false and run `npm run worker` to scale.
    WORKER_INLINE: z
      .string()
      .default("true")
      .transform((v) => v !== "false"),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.AUTH_MODE === "dev" && env.NODE_ENV === "production") issue("AUTH_MODE", "AUTH_MODE=dev is not allowed in production");
    if (env.AUTH_MODE === "firebase" && env.NODE_ENV !== "test") {
      for (const key of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"] as const) {
        if (!env[key]) issue(key, `${key} is required when AUTH_MODE=firebase`);
      }
    }
    if (env.NODE_ENV === "production") {
      if (env.INBOUND_WEBHOOK_TOKEN.length < 24) issue("INBOUND_WEBHOOK_TOKEN", "Use a random token of at least 24 characters");
      if (!env.PUBLIC_BASE_URL.startsWith("https://")) issue("PUBLIC_BASE_URL", "Must be https:// in production");
      if (!env.GEMINI_API_KEY) issue("GEMINI_API_KEY", "Required in production");
    }
    if (env.PAYMENT_PROVIDER === "stripe" && env.NODE_ENV !== "test") {
      if (!env.STRIPE_SECRET_KEY) issue("STRIPE_SECRET_KEY", "Required when PAYMENT_PROVIDER=stripe");
      if (!env.STRIPE_WEBHOOK_SECRET) issue("STRIPE_WEBHOOK_SECRET", "Required when PAYMENT_PROVIDER=stripe");
    }
    if (env.LAUNCH_COUNTRIES.length === 0) issue("LAUNCH_COUNTRIES", "List at least one country code");
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
