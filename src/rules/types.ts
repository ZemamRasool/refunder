// Shared shapes for the rules engine.
import type { DocumentType, ParsedReceipt } from "../services/receiptSchema.js";

/** The facts about one parsed receipt that the rules look at. */
export interface ReceiptFacts {
  id: string;
  merchant: string | null;
  merchantKey: string;
  amountCents: number | null;
  currency: string | null;
  date: string | null; // YYYY-MM-DD
  orderId: string | null;
  documentType: DocumentType;
  category: ParsedReceipt["category"];
  isRecurring: boolean;
  flight: ParsedReceipt["flight"];
}

/** Something a rule found. Becomes a row in the claims table. */
export interface Finding {
  receiptId: string;
  relatedReceiptId?: string;
  dedupeKey: string;
  currency: string | null;
  expectedCents: number | null;
  reason: string;
  details: Record<string, unknown>;
}

/** "Amazon.co.uk", "AMAZON UK LTD" and "amazon" all become "amazon". */
export function merchantKey(name: string | null): string {
  if (!name) return "";
  let s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.(com|co\.uk|co|uk|de|fr|es|it|nl|ie|eu|net|org|io|app)(\/.*)?$/g, "");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  const noise = new Set(["the", "inc", "ltd", "llc", "plc", "limited", "gmbh", "sa", "bv", "co", "uk", "us", "eu", "corp", "company"]);
  return s
    .split(/\s+/)
    .filter((w) => w && !noise.has(w))
    .join("");
}

export function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
