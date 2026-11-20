// Receipt API for the logged-in user.
//   POST /api/receipts       upload a photo, PDF or text file (form field "file")
//   GET  /api/receipts       list my receipts, newest first
//   GET  /api/receipts/:id   one receipt with the full AI result
// Every query includes userId, so one customer can never see another's receipts.
import { Router } from "express";
import multer from "multer";
import type { Db } from "../lib/prisma.js";
import type { Receipt } from "../generated/prisma/client.js";
import { sniffType } from "../lib/fileType.js";
import { audit } from "../lib/audit.js";
import type { ReceiptProcessor } from "../services/receiptProcessor.js";

/** What the browser sees. Never includes the stored file or text. */
export function serializeReceipt(r: Receipt, full = false) {
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    merchant: r.merchant,
    amount: r.amount === null ? null : Number(r.amount),
    currency: r.currency,
    purchaseDate: r.purchaseDate ? r.purchaseDate.toISOString().slice(0, 10) : null,
    orderId: r.orderId,
    error: r.status === "failed" ? r.parseError : null,
    createdAt: r.createdAt,
    ...(full ? { parsed: r.parsedJson } : {}),
  };
}

export function receiptsRouter(prisma: Db, processor: ReceiptProcessor, maxUploadMb: number) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1, fields: 5 } });

  router.post(
    "/",
    (req, res, next) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
          return res
            .status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
            .json({ error: err.code === "LIMIT_FILE_SIZE" ? `File is too big. The limit is ${maxUploadMb} MB.` : "Upload one file." });
        }
        if (err) return next(err);
        next();
      });
    },
    async (req, res) => {
      const file = req.file;
      if (!file || file.size === 0) return res.status(400).json({ error: "Choose a file to upload." });
      // Trust the file's contents, not its name or claimed type.
      const type = sniffType(file.buffer);
      if (!type) return res.status(415).json({ error: "Upload a JPG, PNG, WEBP, GIF, PDF or TXT file." });

      const { receipt, duplicate } = await processor.accept({ userId: req.user!.id, source: "upload", mimeType: type, data: file.buffer });
      await audit(prisma, req, { action: "receipt.upload", targetType: "receipt", targetId: receipt.id, meta: { duplicate } });
      res.status(duplicate ? 200 : 202).json({ ...serializeReceipt(receipt), duplicate });
    },
  );

  router.get("/", async (req, res) => {
    const receipts = await prisma.receipt.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    res.json(receipts.map((r) => serializeReceipt(r)));
  });

  router.get("/:id", async (req, res) => {
    const receipt = await prisma.receipt.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!receipt) return res.status(404).json({ error: "Receipt not found." });
    res.json(serializeReceipt(receipt, true));
  });

  return router;
}
