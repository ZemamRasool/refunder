// Encrypted receipt storage and the 30-day file cleanup.
import { mkdtempSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Encryptor } from "../src/lib/crypto.js";
import { FileStorage } from "../src/services/storage.js";

const enc = new Encryptor("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

describe("encrypted storage", () => {
  it("stores files encrypted and can read them back", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rr-store-"));
    const storage = new FileStorage(root, enc);
    const key = await storage.save("user1", Buffer.from("SECRET RECEIPT"));
    const [file] = readdirSync(path.join(root, "user1"));
    expect(readFileSync(path.join(root, "user1", file)).toString()).not.toContain("SECRET");
    expect((await storage.read(key)).toString()).toBe("SECRET RECEIPT");
  });

  it("deletes files older than 30 days and keeps new ones", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rr-store-"));
    const storage = new FileStorage(root, enc);
    const oldKey = await storage.save("user1", Buffer.from("old"));
    await storage.save("user1", Buffer.from("new"));
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(path.join(root, oldKey), fortyDaysAgo, fortyDaysAgo);
    expect(await storage.deleteOldFiles(30)).toBe(1);
    expect(await storage.deleteOldFiles(30)).toBe(0);
  });

  it("refuses unsafe ids and keys", async () => {
    const storage = new FileStorage(mkdtempSync(path.join(tmpdir(), "rr-store-")), enc);
    await expect(storage.save("../etc", Buffer.from("x"))).rejects.toThrow();
    await expect(storage.read("../../etc/passwd")).rejects.toThrow();
  });
});

