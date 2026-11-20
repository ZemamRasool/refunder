// Rule: duplicate or wrong charges.
//
// Two receipts from the same store, for the same amount, a few days apart.
// Careful about false alarms:
//   - the SAME file sent twice is caught earlier (content fingerprint), never reaches here;
//   - an order confirmation + a payment receipt for the same order is ONE purchase, not two;
//   - shipping and refund emails take no money, so they are ignored;
//   - repeating subscription charges are handled by the subscription rule instead.
// "strong" = same order number charged twice. "possible" = two orders that look identical;
// the user confirms they only meant to buy once before anything is claimed.
import { daysBetween, money, type Finding, type ReceiptFacts } from "./types.js";

export interface DuplicateConditions {
  windowDays: number;
  minAmountCents: number;
}

const CHARGE_TYPES = new Set(["payment_receipt", "invoice", "order_confirmation", "subscription_charge"]);

export function findDuplicates(receipts: ReceiptFacts[], cond: DuplicateConditions): Finding[] {
  const usable = receipts
    .filter(
      (r) =>
        r.merchantKey &&
        r.amountCents !== null &&
        r.amountCents >= cond.minAmountCents &&
        r.currency &&
        r.date &&
        !r.isRecurring &&
        CHARGE_TYPES.has(r.documentType),
    )
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.id < b.id ? -1 : 1));

  const used = new Set<string>();
  const findings: Finding[] = [];

  for (let i = 0; i < usable.length; i++) {
    const a = usable[i];
    if (used.has(a.id)) continue;
    for (let j = i + 1; j < usable.length; j++) {
      const b = usable[j];
      if (used.has(b.id)) continue;
      if (daysBetween(a.date!, b.date!) > cond.windowDays) break;
      if (a.merchantKey !== b.merchantKey || a.currency !== b.currency || a.amountCents !== b.amountCents) continue;

      let confidence: "strong" | "possible" | null = null;
      if (a.orderId && b.orderId && a.orderId === b.orderId) {
        // Same order. Only a real double charge if both documents are the same kind.
        confidence = a.documentType === b.documentType ? "strong" : null;
      } else if (a.documentType === b.documentType && a.category !== "food") {
        // Different (or missing) order numbers: two identical orders. Often a mistake, sometimes on purpose.
        confidence = "possible";
      }
      if (!confidence) continue;

      used.add(a.id);
      used.add(b.id);
      const amount = money(a.amountCents!, a.currency!);
      const sameDay = a.date === b.date;
      findings.push({
        receiptId: b.id,
        relatedReceiptId: a.id,
        dedupeKey: `dup:${a.id}:${b.id}`,
        currency: a.currency,
        expectedCents: a.amountCents,
        reason:
          confidence === "strong"
            ? `${a.merchant} charged you ${amount} twice for order ${a.orderId} (${a.date}${sameDay ? "" : ` and ${b.date}`}). You can ask for one charge back.`
            : `You paid ${a.merchant} ${amount} twice ${sameDay ? `on ${a.date}` : `on ${a.date} and ${b.date}`}. If you only meant to buy once, you can ask for one charge back.`,
        details: {
          confidence,
          question: confidence === "possible" ? "Did you only mean to buy this once?" : null,
          merchant: a.merchant,
          amount: a.amountCents! / 100,
          dates: [a.date, b.date],
          orderIds: [a.orderId, b.orderId],
        },
      });
      break;
    }
  }
  return findings;
}
