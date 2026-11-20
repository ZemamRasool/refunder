// What each background job does.
//   parse_receipt — AI reads one receipt (then queues scan_rules)
//   scan_rules    — rules engine checks all of that user's receipts
import type { Db } from "../lib/prisma.js";
import { scanUser } from "../rules/engine.js";
import type { ReceiptProcessor } from "../services/receiptProcessor.js";
import type { Handlers } from "./queue.js";

export function createHandlers(prisma: Db, processor: ReceiptProcessor): Handlers {
  return {
    parse_receipt: async (job) => {
      await processor.parse(job.payload.receiptId, job.attempts >= job.maxAttempts);
    },
    scan_rules: async (job) => {
      const user = await prisma.user.findUnique({ where: { id: job.payload.userId }, select: { id: true } });
      if (user) await scanUser(prisma, user.id);
    },
  };
}
