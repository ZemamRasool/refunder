// Test settings: a separate test database, dev login, a temp upload folder, a test encryption key.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "dev";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://refundradar:refundradar@127.0.0.1:5432/refundradar_test?schema=public";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.INBOUND_EMAIL_DOMAIN = "in.test.local";
process.env.INBOUND_WEBHOOK_TOKEN = "test-webhook-token-123456789";
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "rr-uploads-"));
process.env.GEMINI_API_KEY = "";
process.env.ADMIN_EMAILS = "boss@example.com";
process.env.LAUNCH_COUNTRIES = "GB,IE";
process.env.FEE_PERCENT = "25";
process.env.PAYMENT_PROVIDER = "manual";
