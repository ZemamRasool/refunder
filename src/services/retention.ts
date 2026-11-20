// SPEC.md trust promise: "delete raw files after 30 days".
// Removes the encrypted original files AND the stored email text. The extracted
// fields (store, amount, date…) stay, because claims depend on them.
import type { Db } from "../lib/prisma.js";
import type { FileStorage } from "./storage.js";

export async function purgeRawData(prisma: Db, storage: FileStorage, days: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const old = await prisma.receipt.findMany({
    where: { createdAt: { lt: cutoff }, OR: [{ rawFileUrl: { not: null } }, { rawText: { not: null } }] },
    select: { id: true, rawFileUrl: true },
    take: 5000,
  });
  for (const r of old) {
    if (r.rawFileUrl) await storage.remove(r.rawFileUrl).catch(() => undefined);
  }
  if (old.length) {
    await prisma.receipt.updateMany({ where: { id: { in: old.map((r) => r.id) } }, data: { rawFileUrl: null, rawText: null } });
  }
  // Safety net for files with no database row (e.g. a crash between save and insert).
  await storage.deleteOldFiles(days, now.getTime());
  return old.length;
}
