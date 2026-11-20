// Rule: forgotten subscriptions.
//
// The same service charging the same customer on a regular cycle (about monthly or yearly),
// and still charging recently. Only the user knows whether they still use it, so the
// finding asks them. If they don't, the claim letter asks the company to cancel and to
// refund the most recent unused charge (many services do this on request).
import { daysBetween, money, type Finding, type ReceiptFacts } from "./types.js";

export interface SubscriptionConditions {
  minCharges: number;
  monthlyDays: [number, number];
  yearlyDays: [number, number];
  // The latest charge must be this recent for the subscription to still be running.
  activeWithinDays: { monthly: number; yearly: number };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function findSubscriptions(receipts: ReceiptFacts[], cond: SubscriptionConditions, now: Date): Finding[] {
  const groups = new Map<string, ReceiptFacts[]>();
  for (const r of receipts) {
    const looksRecurring = r.isRecurring || r.documentType === "subscription_charge" || r.category === "subscription";
    if (!looksRecurring || !r.merchantKey || !r.date || !r.currency || r.amountCents === null || r.amountCents <= 0) continue;
    if (r.documentType === "refund_notice" || r.documentType === "shipping_notice") continue;
    const key = `${r.merchantKey}|${r.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const today = now.toISOString().slice(0, 10);
  const findings: Finding[] = [];

  for (const [key, list] of groups) {
    // One receipt per date (a confirmation and a receipt on the same day count once).
    const byDate = new Map<string, ReceiptFacts>();
    for (const r of list) if (!byDate.has(r.date!)) byDate.set(r.date!, r);
    const charges = [...byDate.values()].sort((a, b) => (a.date! < b.date! ? -1 : 1));
    if (charges.length < cond.minCharges) continue;

    const gaps = charges.slice(1).map((c, i) => daysBetween(charges[i].date!, c.date!));
    const typical = median(gaps);
    const period =
      typical >= cond.monthlyDays[0] && typical <= cond.monthlyDays[1]
        ? "monthly"
        : typical >= cond.yearlyDays[0] && typical <= cond.yearlyDays[1]
          ? "yearly"
          : null;
    if (!period) continue;

    const last = charges[charges.length - 1];
    if (daysBetween(last.date!, today) > cond.activeWithinDays[period]) continue;

    const [merchantKeyPart, currency] = key.split("|");
    const amount = money(last.amountCents!, currency);
    const perYear = period === "monthly" ? last.amountCents! * 12 : last.amountCents!;
    findings.push({
      receiptId: last.id,
      dedupeKey: `sub:${merchantKeyPart}:${currency}`,
      currency,
      expectedCents: last.amountCents,
      reason: `You pay ${last.merchant} ${amount} ${period === "monthly" ? "every month" : "every year"} (${charges.length} charges since ${charges[0].date}, about ${money(perYear, currency)} a year). If you don't use it any more, we'll help you cancel and ask for the last charge back.`,
      details: {
        question: "Do you still use this?",
        merchant: last.merchant,
        period,
        lastAmount: last.amountCents! / 100,
        perYear: perYear / 100,
        chargeDates: charges.map((c) => c.date),
        receiptIds: charges.map((c) => c.id),
      },
    });
  }
  return findings;
}
