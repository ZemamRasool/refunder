// POST /api/waitlist — the landing page's "join the waitlist" form.
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../lib/prisma.js";

const body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  country: z.string().trim().max(60).optional(),
});

export function waitlistRouter(prisma: Db) {
  const router = Router();
  router.post("/", async (req, res) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Please enter a valid email address." });
    const { email, country } = parsed.data;
    // Joining twice is fine: we just keep the first signup.
    await prisma.waitlistSignup.upsert({ where: { email }, update: {}, create: { email, country: country || null } });
    res.status(201).json({ ok: true });
  });
  return router;
}
