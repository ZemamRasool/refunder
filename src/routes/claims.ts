// Money found + claim tracker for the logged-in user.
//   GET   /api/claims                      list + totals ("You may be owed £48")
//   GET   /api/claims/:id
//   POST  /api/claims/scan                 re-check my receipts now
//   POST  /api/claims/:id/flight-outcome   tell us what happened to a flight
//   POST  /api/claims/:id/approve          approve → claim letter is written
//   PATCH /api/claims/:id/letter           edit the letter
//   POST  /api/claims/:id/sent             I sent it
//   POST  /api/claims/:id/won              I got the money → fee is charged
//   POST  /api/claims/:id/lost             the company said no
//   POST  /api/claims/:id/dismiss          not a real claim
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { enqueue } from "../jobs/queue.js";
import { ClaimError, serializeClaim, type ClaimService } from "../services/claims.js";

const outcomeBody = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("delayed"), arrivalDelayMinutes: z.number().int().min(0).max(7 * 24 * 60) }),
  z.object({ outcome: z.literal("cancelled"), noticeDays: z.number().int().min(0).max(365) }),
  z.object({ outcome: z.literal("on_time") }),
]);
const approveBody = z.object({ note: z.string().trim().max(1000).optional() });
const letterBody = z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(20).max(10_000) });
const wonBody = z.object({ recoveredAmount: z.number().positive().max(1_000_000) });

export function claimsRouter(prisma: Db, claims: ClaimService) {
  const router = Router();

  // Turns ClaimError into a clean JSON answer.
  const handle =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof ClaimError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    };

  const send = async (req: Request, res: Response, action: string, claim: Parameters<typeof serializeClaim>[0]) => {
    await audit(prisma, req, { action: `claim.${action}`, targetType: "claim", targetId: claim.id });
    res.json(serializeClaim(claim));
  };

  router.get(
    "/",
    handle(async (req, res) => {
      const list = await claims.list(req.user!.id);
      // Totals per currency, for "You may be owed …" and "You've recovered …".
      const owed: Record<string, number> = {};
      const recovered: Record<string, number> = {};
      for (const c of list) {
        const cur = c.currency ?? "USD";
        if (["found", "approved", "sent"].includes(c.status) && c.expectedAmount) owed[cur] = (owed[cur] ?? 0) + Number(c.expectedAmount);
        if (c.status === "won" && c.recoveredAmount) recovered[cur] = (recovered[cur] ?? 0) + Number(c.recoveredAmount);
      }
      const pendingReceipts = await prisma.receipt.count({ where: { userId: req.user!.id, status: "pending" } });
      res.json({ claims: list.map(serializeClaim), totals: { owed, recovered }, pendingReceipts });
    }),
  );

  router.post(
    "/scan",
    handle(async (req, res) => {
      await enqueue(prisma, "scan_rules", { userId: req.user!.id });
      res.status(202).json({ ok: true });
    }),
  );

  router.get(
    "/:id",
    handle(async (req, res) => {
      res.json(serializeClaim(await claims.get(req.user!.id, String(req.params.id))));
    }),
  );

  router.post(
    "/:id/flight-outcome",
    handle(async (req, res) => {
      const body = outcomeBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Tell us whether the flight was delayed, cancelled or on time." });
      await send(req, res, "flight_outcome", await claims.setFlightOutcome(req.user!.id, String(req.params.id), body.data));
    }),
  );

  router.post(
    "/:id/approve",
    handle(async (req, res) => {
      const body = approveBody.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: "Note is too long." });
      await send(req, res, "approve", await claims.approve(req.user!, String(req.params.id), body.data.note));
    }),
  );

  router.patch(
    "/:id/letter",
    handle(async (req, res) => {
      const body = letterBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "The letter needs a subject and some text." });
      await send(req, res, "edit_letter", await claims.updateLetter(req.user!.id, String(req.params.id), body.data.subject, body.data.body));
    }),
  );

  router.post(
    "/:id/sent",
    handle(async (req, res) => send(req, res, "sent", await claims.markSent(req.user!.id, String(req.params.id)))),
  );

  router.post(
    "/:id/won",
    handle(async (req, res) => {
      const body = wonBody.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Enter the amount you received." });
      await send(req, res, "won", await claims.markWon(req.user!, String(req.params.id), body.data.recoveredAmount));
    }),
  );

  router.post(
    "/:id/lost",
    handle(async (req, res) => send(req, res, "lost", await claims.markLost(req.user!.id, String(req.params.id)))),
  );

  router.post(
    "/:id/dismiss",
    handle(async (req, res) => send(req, res, "dismiss", await claims.dismiss(req.user!.id, String(req.params.id)))),
  );

  return router;
}
