// Payment method + fees for the logged-in user.
//   GET  /api/billing          provider, card status, my fees
//   POST /api/billing/setup    start saving a card (Stripe) — returns a URL to Stripe's own page
// Plus the Stripe webhook (mounted separately with the raw body, see app.ts).
import { Router } from "express";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import type { PaymentProvider } from "../services/payments.js";

export function billingRouter(prisma: Db, payments: PaymentProvider) {
  const router = Router();

  router.get("/", async (req, res) => {
    const fees = await prisma.payout.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      include: { claim: { select: { reason: true, recoveredAmount: true } } },
    });
    res.json({
      provider: payments.name,
      paymentMethodReady: payments.name === "manual" ? true : req.user!.paymentMethodReady,
      fees: fees.map((p) => ({
        id: p.id,
        status: p.status,
        currency: p.currency,
        feePercent: Number(p.feePercent),
        feeAmount: Number(p.feeAmount),
        recoveredAmount: p.claim.recoveredAmount === null ? null : Number(p.claim.recoveredAmount),
        claim: p.claim.reason,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
      })),
    });
  });

  router.post("/setup", async (req, res) => {
    const result = await payments.setupPaymentMethod(req.user!);
    await audit(prisma, req, { action: "billing.setup_start", targetType: "user", targetId: req.user!.id });
    res.json(result);
  });

  return router;
}

export function stripeWebhookRouter(payments: PaymentProvider) {
  const router = Router();
  router.post("/", async (req, res) => {
    if (!payments.handleWebhook) return res.status(404).json({ error: "not enabled" });
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: "missing signature" });
    try {
      const result = await payments.handleWebhook(req.body, signature);
      res.json({ received: true, ...result });
    } catch {
      res.status(400).json({ error: "invalid signature" });
    }
  });
  return router;
}
