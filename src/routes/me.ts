// The logged-in user's own account.
//   GET    /api/me                      who am I, my forwarding address, onboarding state
//   POST   /api/me/onboarding           choose country + accept the fee agreement (required before claims)
//   POST   /api/me/rotate-address       get a new forwarding address (old one stops working)
//   GET    /api/me/export               download all my data as JSON
//   DELETE /api/me                      delete my account and everything in it
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../lib/prisma.js";
import type { User } from "../generated/prisma/client.js";
import type { AuthBackend } from "../auth/verifyToken.js";
import { audit } from "../lib/audit.js";
import { forwardingAddress, newForwardingKey } from "../services/forwardingAddress.js";
import type { FileStorage } from "../services/storage.js";
import { serializeReceipt } from "./receipts.js";

export function meView(u: User, config: Config) {
  return {
    id: u.id,
    email: u.email,
    country: u.country,
    forwardingAddress: forwardingAddress(u.forwardingKey, config.INBOUND_EMAIL_DOMAIN),
    onboarded: Boolean(u.termsAcceptedAt && u.termsVersion === config.TERMS_VERSION && u.country),
    termsVersion: config.TERMS_VERSION,
    feePercent: u.feePercent ? Number(u.feePercent) : config.FEE_PERCENT,
    launchCountries: config.LAUNCH_COUNTRIES,
    isAdmin: config.ADMIN_EMAILS.includes(u.email),
    paymentProvider: config.PAYMENT_PROVIDER,
    paymentMethodReady: config.PAYMENT_PROVIDER === "manual" ? true : u.paymentMethodReady,
    createdAt: u.createdAt,
  };
}

export function meRouter(prisma: Db, config: Config, storage: FileStorage, auth: AuthBackend) {
  const router = Router();

  router.get("/", (req, res) => res.json(meView(req.user!, config)));

  const onboardingBody = z.object({
    country: z.string().trim().toUpperCase().length(2),
    acceptTerms: z.literal(true),
  });

  router.post("/onboarding", async (req, res) => {
    const parsed = onboardingBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose your country and accept the terms." });
    if (!config.LAUNCH_COUNTRIES.includes(parsed.data.country)) {
      // Not launched there yet: keep them on the waitlist with their country.
      await prisma.waitlistSignup.upsert({
        where: { email: req.user!.email },
        update: { country: parsed.data.country },
        create: { email: req.user!.email, country: parsed.data.country },
      });
      return res.status(422).json({ error: "We're not open in your country yet. You're on the waitlist and we'll email you when we launch there." });
    }
    const u = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        country: parsed.data.country,
        termsVersion: config.TERMS_VERSION,
        termsAcceptedAt: new Date(),
        feePercent: config.FEE_PERCENT.toFixed(2),
      },
    });
    await audit(prisma, req, { action: "user.accept_terms", targetType: "user", targetId: u.id, meta: { version: config.TERMS_VERSION, feePercent: config.FEE_PERCENT } });
    res.json(meView(u, config));
  });

  router.post("/rotate-address", async (req, res) => {
    const u = await prisma.user.update({ where: { id: req.user!.id }, data: { forwardingKey: newForwardingKey() } });
    await audit(prisma, req, { action: "user.rotate_address", targetType: "user", targetId: u.id });
    res.json(meView(u, config));
  });

  router.get("/export", async (req, res) => {
    const userId = req.user!.id;
    const [receipts, claims, payouts] = await Promise.all([
      prisma.receipt.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.claim.findMany({ where: { userId }, include: { rule: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
      prisma.payout.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    ]);
    await audit(prisma, req, { action: "user.export", targetType: "user", targetId: userId });
    res.setHeader("Content-Disposition", 'attachment; filename="refundradar-export.json"');
    res.json({
      account: meView(req.user!, config),
      receipts: receipts.map((r) => serializeReceipt(r, true)),
      claims: claims.map((c) => ({
        id: c.id,
        rule: c.rule.name,
        status: c.status,
        currency: c.currency,
        expectedAmount: c.expectedAmount?.toString() ?? null,
        recoveredAmount: c.recoveredAmount?.toString() ?? null,
        reason: c.reason,
        letterSubject: c.letterSubject,
        letterText: c.letterText,
        createdAt: c.createdAt,
      })),
      fees: payouts.map((p) => ({ status: p.status, currency: p.currency, feePercent: p.feePercent.toString(), feeAmount: p.feeAmount.toString(), paidAt: p.paidAt })),
    });
  });

  router.delete("/", async (req, res) => {
    if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: 'Type DELETE to confirm.' });
    const u = req.user!;
    const unpaid = await prisma.payout.count({ where: { userId: u.id, status: { in: ["pending", "processing", "failed"] } } });
    if (unpaid > 0) return res.status(409).json({ error: "Please settle your outstanding fee before deleting your account." });
    await storage.removeUser(u.id);
    await prisma.user.delete({ where: { id: u.id } }); // receipts, claims and payouts are deleted with it
    await auth.deleteUser(u.firebaseUid);
    await audit(prisma, req, { action: "user.delete_account", targetType: "user", targetId: u.id });
    res.json({ ok: true });
  });

  return router;
}
