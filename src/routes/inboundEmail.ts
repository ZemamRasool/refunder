// POST /webhooks/inbound-email?token=...
// When someone forwards a receipt to <key>@in.refundradar.app, the email service
// (Postmark inbound) calls this URL with the email as JSON. We find the user by the
// key in the "To" address, save the attachments or the email text, and answer quickly.
// The AI reads them in the background.
import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../lib/prisma.js";
import { sniffType } from "../lib/fileType.js";
import { audit } from "../lib/audit.js";
import { keyFromAddress } from "../services/forwardingAddress.js";
import type { ReceiptProcessor } from "../services/receiptProcessor.js";

const postmarkSchema = z.object({
  To: z.string().optional(),
  OriginalRecipient: z.string().optional(),
  ToFull: z.array(z.object({ Email: z.string() })).optional(),
  Subject: z.string().max(2000).optional(),
  From: z.string().max(500).optional(),
  TextBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  Attachments: z
    .array(z.object({ Name: z.string().optional(), Content: z.string(), ContentType: z.string() }))
    .max(20)
    .optional(),
});

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Very small HTML-to-text so the AI gets readable text from HTML-only emails. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&pound;/g, "£")
    .replace(/&euro;/g, "€")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function inboundEmailRouter(prisma: Db, processor: ReceiptProcessor, opts: { token: string; domain: string; maxUploadMb: number }) {
  const router = Router();

  router.post("/", async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!opts.token || !sameToken(token, opts.token)) return res.status(401).json({ error: "bad token" });

    const parsed = postmarkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "unexpected payload" });
    const mail = parsed.data;

    const recipients = [mail.OriginalRecipient, ...(mail.ToFull?.map((t) => t.Email) ?? []), ...(mail.To?.split(",") ?? [])].filter(
      (x): x is string => Boolean(x),
    );
    const key = recipients.map((r) => keyFromAddress(r, opts.domain)).find((k) => k !== null) ?? null;
    // Answer 200 for unknown addresses so the email service does not keep retrying.
    if (!key) return res.status(200).json({ ok: true, ignored: "no matching address" });
    const user = await prisma.user.findUnique({ where: { forwardingKey: key } });
    if (!user) return res.status(200).json({ ok: true, ignored: "unknown address" });

    let saved = 0;
    const maxBytes = opts.maxUploadMb * 1024 * 1024;

    for (const att of mail.Attachments ?? []) {
      const data = Buffer.from(att.Content, "base64");
      if (data.length === 0 || data.length > maxBytes) continue;
      const type = sniffType(data);
      // Plain-text attachments are usually signatures or calendar files, not receipts.
      if (!type || type === "text/plain") continue;
      const { duplicate } = await processor.accept({ userId: user.id, source: "email", mimeType: type, data });
      if (!duplicate) saved++;
    }

    // No usable attachment: the email itself is probably the receipt (most online orders).
    if (saved === 0) {
      const body = mail.TextBody?.trim() || (mail.HtmlBody ? htmlToText(mail.HtmlBody) : "");
      if (body) {
        const text = `From: ${mail.From ?? ""}\nSubject: ${mail.Subject ?? ""}\n\n${body}`;
        const { duplicate } = await processor.accept({ userId: user.id, source: "email", mimeType: "text/plain", data: Buffer.from(text, "utf8") });
        if (!duplicate) saved++;
      }
    }

    await audit(prisma, null, { action: "receipt.email_in", targetType: "user", targetId: user.id, meta: { saved } });
    res.status(200).json({ ok: true, receipts: saved });
  });

  return router;
}
