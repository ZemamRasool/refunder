// Saves receipt files to disk, ENCRYPTED, one folder per user, with random file names.
// Even someone who copies the uploads folder cannot read the receipts without ENCRYPTION_KEY.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Encryptor } from "../lib/crypto.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class FileStorage {
  private readonly root: string;

  constructor(
    root: string,
    private readonly crypto: Encryptor,
  ) {
    this.root = path.resolve(root);
  }

  /** Returns a relative key like "<userId>/<uuid>.bin" that is stored in the database. */
  async save(userId: string, data: Buffer): Promise<string> {
    if (!SAFE_ID.test(userId)) throw new Error("bad user id");
    const dir = path.join(this.root, userId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `${randomUUID()}.bin`;
    await writeFile(path.join(dir, name), this.crypto.encrypt(data), { mode: 0o600 });
    return `${userId}/${name}`;
  }

  async read(key: string): Promise<Buffer> {
    return this.crypto.decrypt(await readFile(this.resolve(key)));
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async removeUser(userId: string): Promise<void> {
    if (!SAFE_ID.test(userId)) throw new Error("bad user id");
    await rm(path.join(this.root, userId), { recursive: true, force: true });
  }

  /** Delete raw files older than maxAgeDays. Returns how many were removed. */
  async deleteOldFiles(maxAgeDays: number, now = Date.now()): Promise<number> {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    let users: string[] = [];
    try {
      users = await readdir(this.root);
    } catch {
      return 0;
    }
    for (const user of users) {
      const dir = path.join(this.root, user);
      if (!SAFE_ID.test(user) || !(await stat(dir)).isDirectory()) continue;
      for (const file of await readdir(dir)) {
        const full = path.join(dir, file);
        if ((await stat(full)).mtimeMs < cutoff) {
          await rm(full, { force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  // Keys come from our own database, but check anyway so a bad key can never escape the folder.
  private resolve(key: string): string {
    const [userId, name, ...rest] = key.split("/");
    if (rest.length || !userId || !name || !SAFE_ID.test(userId) || !/^[a-f0-9-]+\.bin$/.test(name)) {
      throw new Error("bad storage key");
    }
    return path.join(this.root, userId, name);
  }
}
