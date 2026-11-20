// The rules engine: plain code, not AI (SPEC.md). Same receipts in → same findings out.
// It looks at one user's parsed receipts, runs every active rule, and saves new findings
// as claims with status "found". Running it again never creates duplicates (dedupe key),
// and a finding the user dismissed never comes back.
import type { Db } from "../lib/prisma.js";
import type { ClaimRule } from "../generated/prisma/client.js";
import { parsedReceiptSchema } from "../services/receiptSchema.js";
import { findDuplicates, type DuplicateConditions } from "./duplicate.js";
import { findSubscriptions, type SubscriptionConditions } from "./subscription.js";
import { assessFlight, type Regime } from "./flight.js";
import { merchantKey, money, type Finding, type ReceiptFacts } from "./types.js";

export function toFacts(r: { id: string; parsedJson: unknown }): ReceiptFacts | null {
  const parsed = parsedReceiptSchema.safeParse(r.parsedJson);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    id: r.id,
    merchant: p.merchant,
    merchantKey: merchantKey(p.merchant),
    amountCents: p.total_amount === null ? null : Math.round(p.total_amount * 100),
    currency: p.currency,
    date: p.purchase_date,
    orderId: p.order_id,
    documentType: p.document_type,
    category: p.category,
    isRecurring: p.is_recurring,
    flight: p.flight,
  };
}

export function findFlights(receipts: ReceiptFacts[], cond: { regime: Regime; maxAgeYears: number }, now: Date): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const r of receipts) {
    if (!r.flight) continue;
    const a = assessFlight(
      {
        flightNumber: r.flight.flight_number,
        departure: r.flight.departure_airport,
        arrival: r.flight.arrival_airport,
        scheduledDeparture: r.flight.scheduled_departure,
      },
      now,
      cond.maxAgeYears,
    );
    if (!a || a.regime !== cond.regime) continue;
    // Same flight forwarded as booking + boarding pass + e-ticket counts once.
    const key = `flight:${a.flightNumber ?? `${a.departure}-${a.arrival}`}:${a.flightDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      receiptId: r.id,
      dedupeKey: key,
      currency: a.currency,
      expectedCents: null, // known once the user tells us what happened
      reason: `Flight ${a.flightNumber ?? ""} ${a.departure}→${a.arrival} on ${a.flightDate} is covered by ${a.regime}. If it arrived 3+ hours late or was cancelled at short notice, you may be owed up to ${money(a.maxAmount * 100, a.currency)}.`.replace(/\s+/g, " "),
      details: {
        ...a,
        airline: r.flight.airline ?? r.merchant,
        bookingReference: r.orderId,
        question: "What happened to this flight?",
        needsInput: "flight_outcome",
      },
    });
  }
  return findings;
}

export function runRule(rule: ClaimRule, facts: ReceiptFacts[], now: Date): Finding[] {
  const cond = rule.conditionsJson as Record<string, unknown>;
  switch (rule.type) {
    case "duplicate_charge":
      return findDuplicates(facts, cond as unknown as DuplicateConditions);
    case "forgotten_subscription":
      return findSubscriptions(facts, cond as unknown as SubscriptionConditions, now);
    case "flight_compensation":
      return findFlights(facts, cond as unknown as { regime: Regime; maxAgeYears: number }, now);
  }
}

/** Scan one user's receipts. Returns how many new findings were saved. */
export async function scanUser(prisma: Db, userId: string, now = new Date()): Promise<number> {
  const [rules, receipts] = await Promise.all([
    prisma.claimRule.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    prisma.receipt.findMany({ where: { userId, status: "parsed" }, select: { id: true, parsedJson: true } }),
  ]);
  const facts = receipts.map(toFacts).filter((f): f is ReceiptFacts => f !== null);

  const rows = rules.flatMap((rule) =>
    runRule(rule, facts, now).map((f) => ({
      userId,
      ruleId: rule.id,
      receiptId: f.receiptId,
      relatedReceiptId: f.relatedReceiptId ?? null,
      dedupeKey: f.dedupeKey,
      currency: f.currency,
      expectedAmount: f.expectedCents === null ? null : (f.expectedCents / 100).toFixed(2),
      reason: f.reason,
      detailsJson: f.details as object,
    })),
  );
  if (rows.length === 0) return 0;
  const result = await prisma.claim.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}
