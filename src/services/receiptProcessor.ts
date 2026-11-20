// The receipt pipeline.
//   1. accept(): save the encrypted original, create the receipt row ("pending"), queue a job. Fast.
//   2. parse():  (in the background) decrypt, send to the AI, validate, save the fields,
//                then queue a rules scan for that user.
import type { Db } from "../lib/prisma.js";
import type { Receipt } from "../generated/prisma/client.js";
import { sha256, type Encryptor } from "../lib/crypto.js";
import type { AllowedType } from "../lib/fileType.js";
import { enqueue } from "../jobs/queue.js";
import type { FileStorage } from "./storage.js";
import type { ReceiptInput, ReceiptParser } from "./receiptParser.js";

export interface IncomingReceipt {
  userId: string;
  source: "upload" | "email";
  mimeType: AllowedType;
  data: Buffer;
}

export class RetryLater extends Error {}

export class ReceiptProcessor {
  constructor(
    private readonly prisma: Db,
    private readonly storage: FileStorage,
    private readonly crypto: Encryptor,
    private readonly parseWithAi: ReceiptParser,
  ) {}

  /** Save and queue. Returns { duplicate: true } if this exact receipt was already received. */
  async accept(incoming: IncomingReceipt): Promise<{ receipt: Receipt; duplicate: boolean }> {
    const { userId, source, mimeType, data } = incoming;
    const contentHash = sha256(data);

    const existing = await this.prisma.receipt.findFirst({ where: { userId, contentHash } });
    if (existing) return { receipt: existing, duplicate: true };

    const isText = mimeType === "text/plain";
    const rawFileUrl = isText ? null : await this.storage.save(userId, data);
    const receipt = await this.prisma.receipt.create({
      data: {
        userId,
        source,
        status: "pending",
        rawFileUrl,
        mimeType,
        contentHash,
        rawText: isText ? this.crypto.encryptText(data.toString("utf8").slice(0, 100_000)) : null,
      },
    });
    await enqueue(this.prisma, "parse_receipt", { receiptId: receipt.id });
    return { receipt, duplicate: false };
  }

  async parse(receiptId: string, isLastAttempt: boolean): Promise<Receipt | null> {
    const receipt = await this.prisma.receipt.findUnique({ where: { id: receiptId } });
    if (!receipt || receipt.status === "parsed") return receipt;

    const input = await this.loadInput(receipt);
    if (!input) {
      return this.prisma.receipt.update({
        where: { id: receipt.id },
        data: { status: "failed", parseError: "The original file is no longer available." },
      });
    }

    const result = await this.parseWithAi(input);
    if (!result.ok) {
      if (result.retryable && !isLastAttempt) {
        await this.prisma.receipt.update({ where: { id: receipt.id }, data: { parseError: `${result.error} (will retry)` } });
        throw new RetryLater(result.error);
      }
      return this.prisma.receipt.update({ where: { id: receipt.id }, data: { status: "failed", parseError: result.error } });
    }

    const r = result.receipt;
    const updated = await this.prisma.receipt.update({
      where: { id: receipt.id },
      data: {
        status: "parsed",
        merchant: r.merchant,
        amount: r.total_amount === null ? null : r.total_amount.toFixed(2),
        currency: r.currency,
        purchaseDate: r.purchase_date ? new Date(`${r.purchase_date}T00:00:00Z`) : null,
        orderId: r.order_id,
        parsedJson: r,
        parseError: null,
      },
    });
    await enqueue(this.prisma, "scan_rules", { userId: receipt.userId });
    return updated;
  }

  private async loadInput(receipt: Receipt): Promise<ReceiptInput | null> {
    try {
      if (receipt.rawText) return { kind: "text", text: this.crypto.decryptText(receipt.rawText) };
      if (!receipt.rawFileUrl) return null;
      const data = await this.storage.read(receipt.rawFileUrl);
      if (receipt.mimeType === "application/pdf") return { kind: "pdf", data };
      if (receipt.mimeType?.startsWith("image/")) {
        return { kind: "image", mimeType: receipt.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data };
      }
      return null;
    } catch {
      return null;
    }
  }
}
