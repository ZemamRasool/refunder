// The claim tracker (Milestone 3) and fee step (Milestone 4).
//
//   found ──approve──▶ approved ──mark sent──▶ sent ──▶ won  (fee charged)
//     │                   │                       └───▶ lost
//     └──dismiss──────────┴──▶ dismissed
//
// Every change checks that the claim belongs to the user AND is in the right status,
// in one database statement, so double-clicks or two tabs can't break the flow.
import type { Claim, ClaimRule, ClaimStatus, Receipt, User } from "../generated/prisma/client.js";
import type { Config } from "../config.js";
import type { Db } from "../lib/prisma.js";
import { feeCents, formatMoney, fromCents, toCents } from "../lib/money.js";
import { compensation, type FlightAssessment, type FlightOutcome } from "../rules/flight.js";
import type { LetterWriter } from "./letterWriter.js";
import type { PaymentProvider } from "./payments.js";

export class ClaimError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type ClaimWithParts = Claim & { rule: ClaimRule; receipt: Receipt };

export function serializeClaim(c: Claim & { rule: ClaimRule; receipt?: Pick<Receipt, "merchant"> | null }) {
  const d = (c.detailsJson ?? {}) as Record<string, unknown>;
  return {
    id: c.id,
    type: c.rule.type,
    ruleName: c.rule.name,
    status: c.status,
    currency: c.currency,
    expectedAmount: c.expectedAmount === null ? null : Number(c.expectedAmount),
    recoveredAmount: c.recoveredAmount === null ? null : Number(c.recoveredAmount),
    reason: c.reason,
    question: (d.question as string | null) ?? null,
    needsInput: (d.needsInput as string | null) ?? null,
    details: d,
    merchant: c.receipt?.merchant ?? null,
    receiptId: c.receiptId,
    letterSubject: c.letterSubject,
    letterText: c.letterText,
    approvedAt: c.approvedAt,
    sentAt: c.sentAt,
    resolvedAt: c.resolvedAt,
    createdAt: c.createdAt,
  };
}

function describeOutcome(o: FlightOutcome): string {
  if (o.outcome === "cancelled") return `The flight was cancelled ${o.noticeDays === 0 ? "on the day" : `${o.noticeDays} day(s) before departure`}.`;
  if (o.outcome === "delayed") {
    const h = Math.floor(o.arrivalDelayMinutes / 60);
    const m = o.arrivalDelayMinutes % 60;
    return `The flight arrived ${h} hour(s)${m ? ` ${m} minute(s)` : ""} late at the final destination.`;
  }
  return "The flight was on time.";
}

export class ClaimService {
  constructor(
    private readonly prisma: Db,
    private readonly writeLetter: LetterWriter,
    private readonly payments: PaymentProvider,
    private readonly config: Config,
  ) {}

  async list(userId: string) {
    return this.prisma.claim.findMany({
      where: { userId },
      include: { rule: true, receipt: { select: { merchant: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(userId: string, id: string): Promise<ClaimWithParts> {
    const claim = await this.prisma.claim.findFirst({ where: { id, userId }, include: { rule: true, receipt: true } });
    if (!claim) throw new ClaimError(404, "Claim not found.");
    return claim;
  }

  /** Atomic status change. Throws 409 if the claim is not in one of the `from` statuses. */
  private async move(userId: string, id: string, from: ClaimStatus[], data: Parameters<Db["claim"]["updateMany"]>[0]["data"]) {
    const res = await this.prisma.claim.updateMany({ where: { id, userId, status: { in: from } }, data });
    if (res.count === 0) {
      await this.get(userId, id); // 404 if not theirs
      throw new ClaimError(409, `This claim can't be changed from its current status.`);
    }
    return this.get(userId, id);
  }

  async setFlightOutcome(userId: string, id: string, outcome: FlightOutcome) {
    const claim = await this.get(userId, id);
    if (claim.rule.type !== "flight_compensation") throw new ClaimError(400, "Only flight claims need this.");
    if (claim.status !== "found") throw new ClaimError(409, "This claim has already been handled.");
    const details = claim.detailsJson as unknown as FlightAssessment & Record<string, unknown>;
    const amount = compensation(details, outcome);
    const newDetails = { ...details, outcome, needsInput: null, question: null };
    if (amount === 0) {
      return this.move(userId, id, ["found"], {
        status: "dismissed",
        resolvedAt: new Date(),
        detailsJson: { ...newDetails, dismissedReason: "Not eligible: delay under 3 hours, on time, or cancelled with 14+ days' notice." },
      });
    }
    return this.move(userId, id, ["found"], {
      expectedAmount: amount.toFixed(2),
      reason: `${details.regime}: flight ${details.flightNumber ?? ""} ${details.departure}→${details.arrival} on ${details.flightDate}. ${describeOutcome(outcome)} You are likely owed ${formatMoney(amount, details.currency)}.`.replace(/\s+/g, " "),
      detailsJson: newDetails,
    });
  }

  async approve(user: User, id: string, note?: string) {
    if (!user.termsAcceptedAt) throw new ClaimError(403, "Please accept the terms in Settings first.");
    if (this.payments.name === "stripe" && !user.paymentMethodReady) {
      throw new ClaimError(402, "Please add a payment method in Settings first. You are only charged if money is recovered.");
    }
    const claim = await this.get(user.id, id);
    if (claim.status !== "found") throw new ClaimError(409, "This claim has already been handled.");
    if (claim.expectedAmount === null) throw new ClaimError(400, "Tell us what happened first.");

    const letter = await this.writeLetter({ templateText: claim.rule.templateText, values: this.letterValues(claim, user), userNote: note });
    return this.move(user.id, id, ["found"], {
      status: "approved",
      approvedAt: new Date(),
      letterSubject: letter.subject,
      letterText: letter.body,
    });
  }

  async updateLetter(userId: string, id: string, subject: string, body: string) {
    return this.move(userId, id, ["approved"], { letterSubject: subject, letterText: body });
  }

  async markSent(userId: string, id: string) {
    return this.move(userId, id, ["approved"], { status: "sent", sentAt: new Date() });
  }

  async markLost(userId: string, id: string) {
    const claim = await this.move(userId, id, ["sent"], { status: "lost", resolvedAt: new Date() });
    await this.updateSuccessRate(claim.ruleId);
    return claim;
  }

  async dismiss(userId: string, id: string) {
    return this.move(userId, id, ["found", "approved"], { status: "dismissed", resolvedAt: new Date() });
  }

  /** The user got the money. Record it, then work out and charge our fee. */
  async markWon(user: User, id: string, recoveredAmount: number) {
    const recovered = toCents(recoveredAmount);
    if (recovered <= 0 || recovered > 100_000_000) throw new ClaimError(400, "Enter the amount you received.");
    const claim = await this.move(user.id, id, ["approved", "sent"], {
      status: "won",
      resolvedAt: new Date(),
      recoveredAmount: fromCents(recovered),
    });
    await this.updateSuccessRate(claim.ruleId);

    const percent = user.feePercent ? Number(user.feePercent) : this.config.FEE_PERCENT;
    const fee = feeCents(recovered, percent);
    const currency = claim.currency ?? claim.receipt.currency ?? "USD";
    // Card networks have a minimum charge; tiny fees are waived rather than failing.
    const tiny = fee < 50;
    const payout = await this.prisma.payout.create({
      data: {
        claimId: claim.id,
        userId: user.id,
        currency,
        feePercent: percent.toFixed(2),
        feeAmount: fromCents(fee),
        provider: this.payments.name,
        status: tiny ? "waived" : "pending",
        failureReason: tiny ? "Fee below minimum charge" : null,
      },
    });
    if (!tiny) await this.charge(payout.id);
    return claim;
  }

  /** Charge (or re-try charging) one fee. Safe to call more than once. */
  async charge(payoutId: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId }, include: { user: true } });
    if (!payout || !["pending", "failed"].includes(payout.status)) return payout;
    const result = await this.payments.chargeFee(payout, payout.user);
    return this.prisma.payout.update({
      where: { id: payout.id },
      data: {
        status: result.status,
        providerRef: result.providerRef ?? payout.providerRef,
        failureReason: result.failureReason ?? null,
        paidAt: result.status === "paid" ? new Date() : null,
      },
    });
  }

  /** SPEC.md: "track the success rate per rule and drop the weak ones". */
  async updateSuccessRate(ruleId: string) {
    const [won, lost] = await Promise.all([
      this.prisma.claim.count({ where: { ruleId, status: "won" } }),
      this.prisma.claim.count({ where: { ruleId, status: "lost" } }),
    ]);
    await this.prisma.claimRule.update({ where: { id: ruleId }, data: { successRate: won + lost ? won / (won + lost) : null } });
  }

  letterValues(claim: ClaimWithParts, user: User): Record<string, string> {
    const d = (claim.detailsJson ?? {}) as Record<string, unknown>;
    const currency = claim.currency ?? claim.receipt.currency ?? "USD";
    // Unique, non-empty values joined in plain English ("A1 and A2"; "A1" if both are the same).
    const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter(Boolean).map(String))].join(" and ") : "");
    const chargeDates = Array.isArray(d.chargeDates) ? (d.chargeDates as string[]) : [];
    return {
      merchant: String(d.merchant ?? claim.receipt.merchant ?? ""),
      amount: claim.expectedAmount === null ? "" : formatMoney(Number(claim.expectedAmount), currency),
      customer_email: user.email,
      order_id: String(d.bookingReference ?? claim.receipt.orderId ?? ""),
      order_ids: list(d.orderIds),
      dates: list(d.dates),
      last_date: chargeDates[chargeDates.length - 1] ?? "",
      flight_number: String(d.flightNumber ?? ""),
      flight_date: String(d.flightDate ?? ""),
      departure: String(d.departure ?? ""),
      arrival: String(d.arrival ?? ""),
      airline: String(d.airline ?? claim.receipt.merchant ?? ""),
      distance_km: d.distanceKm ? String(d.distanceKm) : "",
      what_happened: d.outcome ? describeOutcome(d.outcome as FlightOutcome) : "",
    };
  }
}
