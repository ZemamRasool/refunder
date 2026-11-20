// Money maths in whole cents, so 0.1 + 0.2 problems never touch a fee.

// Currencies that have no minor unit (Stripe "zero-decimal" currencies we may see).
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

export function toCents(amount: number | string | { toString(): string }): number {
  const n = typeof amount === "number" ? amount : Number(amount.toString());
  if (!Number.isFinite(n)) throw new Error("not a number");
  return Math.round(n * 100);
}

export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Fee = recovered × percent, rounded to the nearest cent. */
export function feeCents(recoveredCents: number, percent: number): number {
  return Math.round((recoveredCents * percent) / 100);
}

/** Amount in the provider's smallest unit (cents for USD/GBP/EUR, whole yen for JPY). */
export function toMinorUnits(cents: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(cents / 100) : cents;
}

export function formatMoney(amount: number | string, currency: string): string {
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}
