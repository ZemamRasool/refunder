// Encryption, file-type checks, money maths, letter templates and config safety.
import { describe, expect, it } from "vitest";
import { Encryptor, sha256 } from "../src/lib/crypto.js";
import { sniffType } from "../src/lib/fileType.js";
import { feeCents, toCents, toMinorUnits } from "../src/lib/money.js";
import { fillTemplate } from "../src/services/letterWriter.js";
import { loadConfig } from "../src/config.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const enc = new Encryptor(KEY);

describe("encryption", () => {
  it("round-trips and never stores plain text", () => {
    const sealed = enc.encryptText("Order 123 total £5");
    expect(sealed).not.toContain("Order");
    expect(enc.decryptText(sealed)).toBe("Order 123 total £5");
  });

  it("detects tampering", () => {
    const sealed = enc.encrypt(Buffer.from("hello"));
    sealed[sealed.length - 1] ^= 1;
    expect(() => enc.decrypt(sealed)).toThrow();
  });

  it("can't be read with a different key", () => {
    const other = new Encryptor("f".repeat(64));
    expect(() => other.decrypt(enc.encrypt(Buffer.from("x")))).toThrow();
  });

  it("fingerprints content", () => {
    expect(sha256("a")).toBe(sha256("a"));
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

describe("file type sniffing", () => {
  it("recognises real files and rejects others", () => {
    expect(sniffType(Buffer.from("%PDF-1.7 ..."))).toBe("application/pdf");
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(sniffType(Buffer.from("Thanks for your order ✓"))).toBe("text/plain");
    expect(sniffType(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull(); // Windows .exe
  });
});

describe("money", () => {
  it("rounds fees to the cent", () => {
    expect(feeCents(toCents(48.0), 25)).toBe(1200);
    expect(feeCents(toCents(33.33), 25)).toBe(833);
    expect(toCents("0.29")).toBe(29);
    expect(toMinorUnits(1250, "JPY")).toBe(13);
    expect(toMinorUnits(1250, "GBP")).toBe(1250);
  });
});

describe("letter template", () => {
  it("fills placeholders and marks missing ones for the user", () => {
    const l = fillTemplate("Subject: Refund {{order_id}}\n\nHello {{merchant}}, please refund {{amount}}. {{unknown_thing}}", {
      order_id: "A1",
      merchant: "Shop",
      amount: "£5.00",
    });
    expect(l.subject).toBe("Refund A1");
    expect(l.body).toBe("Hello Shop, please refund £5.00. [unknown thing]");
  });
});

describe("config safety", () => {
  const base = { DATABASE_URL: "postgres://x", ENCRYPTION_KEY: KEY };
  it("refuses dev login in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "dev" })).toThrow(/AUTH_MODE/);
  });
  it("requires an encryption key", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", NODE_ENV: "test" })).toThrow(/ENCRYPTION_KEY/);
  });
  it("keeps the fee inside 20–30%", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "test", FEE_PERCENT: "45" })).toThrow(/FEE_PERCENT/);
  });
});
