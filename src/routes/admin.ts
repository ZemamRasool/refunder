// Admin dashboard API (Milestone 4). Only emails in ADMIN_EMAILS get in, and every
// request is written to the audit log (requireAdmin in middleware/requireAuth.ts).
//   GET   /api/admin/overview             numbers at a glance
//   GET   /api/admin/rules                rules with won/lost counts and success rate
//   PATCH /api/admin/rules/:id            switch a rule on/off
//   GET   /api/admin/claims?status=       all claims (newest first)
//   GET   /api/admin/payouts?status=      fees
//   POST  /api/admin/payouts/:id/mark-paid   (manual payments: you received the fee)
//   POST  /api/admin/payouts/:id/waive
//   POST  /api/admin/payouts/:id/retry       (charge a failed card again)
//   GET   /api/admin/jobs                 failed background jobs
//   POST  /api/admin/jobs/:id/retry
//   GET   /api/admin/audit                latest audit log entries
import { Router } from "express";
import { z } from "zod";
import type { ClaimStatus, PayoutStatus } from "../generated/prisma/client.js";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import type { ClaimService } from "../services/claims.js";

const CLAIM_STATUSES = ["found", "approved", "sent", "won", "lost", "dismissed"] as const;
const PAYOUT_STATUSES = ["pending", "processing", "paid", "failed", "waived"] as const;

function sumBy<T>(rows: T[], key: (r: T) => string, value: (r: T) => number) {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = Math.round(((out[key(r)] ?? 0) + value(r)) * 100) / 100;
  return out;
}

export function adminRouter(prisma: Db, claims: ClaimService) {
  const router = Router();

  router.get("/overview", async (_req, res) => {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [users, newUsers, waitlist, receiptsByStatus, claimsByStatus, wonClaims, payouts, failedJobs, queuedJobs] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: since } } }),
      prisma.waitlistSignup.count(),
      prisma.receipt.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.claim.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.claim.findMany({ where: { status: "won" }, select: { currency: true, recoveredAmount: true } }),
      prisma.payout.findMany({ select: { status: true, currency: true, feeAmount: true } }),
      prisma.job.count({ where: { status: "failed" } }),
      prisma.job.count({ where: { status: { in: ["queued", "running"] } } }),
    ]);
    res.json({
      users,
      newUsers30d: newUsers,
      waitlist,
      receipts: Object.fromEntries(receiptsByStatus.map((r) => [r.status, r._count._all])),
      claims: Object.fromEntries(claimsByStatus.map((r) => [r.status, r._count._all])),
      recovered: sumBy(wonClaims, (c) => c.currency ?? "USD", (c) => Number(c.recoveredAmount ?? 0)),
      feesPaid: sumBy(payouts.filter((p) => p.status === "paid"), (p) => p.currency, (p) => Number(p.feeAmount)),
      feesOutstanding: sumBy(payouts.filter((p) => ["pending", "processing", "failed"].includes(p.status)), (p) => p.currency, (p) => Number(p.feeAmount)),
      jobs: { failed: failedJobs, waiting: queuedJobs },
    });
  });

  router.get("/rules", async (_req, res) => {
    const rules = await prisma.claimRule.findMany({ orderBy: { code: "asc" } });
    const counts = await prisma.claim.groupBy({ by: ["ruleId", "status"], _count: { _all: true } });
    res.json(
      rules.map((r) => {
        const c = (s: ClaimStatus) => counts.find((x) => x.ruleId === r.id && x.status === s)?._count._all ?? 0;
        return {
          id: r.id,
          code: r.code,
          name: r.name,
          type: r.type,
          country: r.country,
          active: r.active,
          successRate: r.successRate,
          counts: Object.fromEntries(CLAIM_STATUSES.map((s) => [s, c(s)])),
          conditions: r.conditionsJson,
        };
      }),
    );
  });

  router.patch("/rules/:id", async (req, res) => {
    const body = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Send { active: true|false }." });
    const rule = await prisma.claimRule.update({ where: { id: String(req.params.id) }, data: { active: body.data.active } }).catch(() => null);
    if (!rule) return res.status(404).json({ error: "Rule not found." });
    await audit(prisma, req, { action: "admin.rule_toggle", targetType: "claim_rule", targetId: rule.id, meta: { active: rule.active } });
    res.json({ id: rule.id, active: rule.active });
  });

  router.get("/claims", async (req, res) => {
    const status = CLAIM_STATUSES.find((s) => s === req.query.status);
    const list = await prisma.claim.findMany({
      where: status ? { status } : {},
      include: { rule: { select: { name: true } }, user: { select: { email: true } }, receipt: { select: { merchant: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(
      list.map((c) => ({
        id: c.id,
        user: c.user.email,
        rule: c.rule.name,
        merchant: c.receipt.merchant,
        status: c.status,
        currency: c.currency,
        expectedAmount: c.expectedAmount === null ? null : Number(c.expectedAmount),
        recoveredAmount: c.recoveredAmount === null ? null : Number(c.recoveredAmount),
        reason: c.reason,
        createdAt: c.createdAt,
      })),
    );
  });

  router.get("/payouts", async (req, res) => {
    const status = PAYOUT_STATUSES.find((s) => s === req.query.status);
    const list = await prisma.payout.findMany({
      where: status ? { status } : {},
      include: { user: { select: { email: true } }, claim: { select: { recoveredAmount: true, reason: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(
      list.map((p) => ({
        id: p.id,
        user: p.user.email,
        status: p.status,
        provider: p.provider,
        currency: p.currency,
        feePercent: Number(p.feePercent),
        feeAmount: Number(p.feeAmount),
        recoveredAmount: p.claim.recoveredAmount === null ? null : Number(p.claim.recoveredAmount),
        claim: p.claim.reason,
        failureReason: p.failureReason,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
      })),
    );
  });

  const payoutAction = (action: string, from: PayoutStatus[], data: () => object) =>
    router.post(`/payouts/:id/${action}`, async (req, res) => {
      const result = await prisma.payout.updateMany({ where: { id: String(req.params.id), status: { in: from } }, data: data() });
      if (result.count === 0) return res.status(409).json({ error: "This fee can't be changed from its current status." });
      await audit(prisma, req, { action: `admin.payout_${action}`, targetType: "payout", targetId: String(req.params.id) });
      res.json({ ok: true });
    });
  payoutAction("mark-paid", ["pending", "failed", "processing"], () => ({ status: "paid", paidAt: new Date(), failureReason: null }));
  payoutAction("waive", ["pending", "failed"], () => ({ status: "waived" }));

  router.post("/payouts/:id/retry", async (req, res) => {
    const payout = await claims.charge(String(req.params.id));
    if (!payout) return res.status(404).json({ error: "Fee not found." });
    await audit(prisma, req, { action: "admin.payout_retry", targetType: "payout", targetId: payout.id, meta: { status: payout.status } });
    res.json({ id: payout.id, status: payout.status, failureReason: payout.failureReason });
  });

  router.get("/jobs", async (_req, res) => {
    const jobs = await prisma.job.findMany({ where: { status: "failed" }, orderBy: { updatedAt: "desc" }, take: 100 });
    res.json(jobs.map((j) => ({ id: j.id, type: j.type, attempts: j.attempts, lastError: j.lastError, updatedAt: j.updatedAt })));
  });

  router.post("/jobs/:id/retry", async (req, res) => {
    const result = await prisma.job.updateMany({
      where: { id: String(req.params.id), status: "failed" },
      data: { status: "queued", attempts: 0, runAt: new Date(), lastError: null },
    });
    if (result.count === 0) return res.status(404).json({ error: "Failed job not found." });
    res.json({ ok: true });
  });

  router.get("/audit", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    res.json(rows);
  });

  return router;
}
