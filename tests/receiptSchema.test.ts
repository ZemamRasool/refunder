// Checks that the AI's answer is validated before saving (no database needed).
import { describe, expect, it } from "vitest";
import { validateParsed } from "../src/services/receiptParser.js";
import { keyFromAddress, newForwardingKey } from "../src/services/forwardingAddress.js";
import { htmlToText } from "../src/routes/inboundEmail.js";

const good = {
  is_receipt: true,
  merchant: "Netflix",
  total_amount: 15.49,
  currency: "gbp",
  purchase_date: "2026-09-14",
  order_id: null,
  category: "subscription",
  document_type: "subscription_charge",
  is_recurring: true,
  items: [],
  flight: null,
};

describe("validateParsed", () => {
  it("accepts a correct answer and normalises the currency", () => {
    const r = validateParsed(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.receipt.currency).toBe("GBP");
  });

  it("rejects a negative amount", () => {
    expect(validateParsed({ ...good, total_amount: -5 }).ok).toBe(false);
  });

  it("rejects a badly formatted or impossible date", () => {
    expect(validateParsed({ ...good, purchase_date: "14/09/2026" }).ok).toBe(false);
    expect(validateParsed({ ...good, purchase_date: "2026-13-45" }).ok).toBe(false);
  });

  it("rejects an amount sent as text", () => {
    expect(validateParsed({ ...good, total_amount: "15.49" }).ok).toBe(false);
  });

  it("rejects missing fields and unknown document types", () => {
    const { merchant: _m, ...rest } = good;
    expect(validateParsed(rest).ok).toBe(false);
    expect(validateParsed({ ...good, document_type: "love_letter" }).ok).toBe(false);
  });

  it("rejects documents that are not receipts", () => {
    expect(validateParsed({ ...good, is_receipt: false })).toEqual({ ok: false, error: "This does not look like a receipt." });
  });

  it("accepts a flight and cleans up airport codes and flight numbers", () => {
    const r = validateParsed({
      ...good,
      merchant: "British Airways",
      category: "flight",
      document_type: "booking_confirmation",
      is_recurring: false,
      flight: { airline: "British Airways", flight_number: "ba 117", departure_airport: "lhr", arrival_airport: "New York JFK", scheduled_departure: "2026-10-01T11:20:00Z" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.receipt.flight?.flight_number).toBe("BA117");
      expect(r.receipt.flight?.departure_airport).toBe("LHR");
      expect(r.receipt.flight?.arrival_airport).toBeNull(); // not a code, so dropped rather than guessed
    }
  });
});

describe("forwarding address", () => {
  it("makes random 10-character keys", () => {
    const a = newForwardingKey();
    expect(a).toMatch(/^[a-z0-9]{10}$/);
    expect(newForwardingKey()).not.toBe(a);
  });

  it("reads the key from a recipient address", () => {
    expect(keyFromAddress("Me <abc234xyz9@in.test.local>", "in.test.local")).toBe("abc234xyz9");
    expect(keyFromAddress("abc234xyz9@other.com", "in.test.local")).toBeNull();
  });
});

describe("htmlToText", () => {
  it("strips tags and scripts", () => {
    expect(htmlToText("<p>Total: <b>&pound;5</b></p><script>alert(1)</script>")).toBe("Total: £5");
  });
});
