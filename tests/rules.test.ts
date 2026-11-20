// The rules engine is plain code, so it is tested with plain data (no database, no AI).
import { describe, expect, it } from "vitest";
import { findDuplicates } from "../src/rules/duplicate.js";
import { findSubscriptions } from "../src/rules/subscription.js";
import { findFlights } from "../src/rules/engine.js";
import { assessFlight, compensation, regimeFor } from "../src/rules/flight.js";
import { airport, carrierCode, distanceKm } from "../src/rules/airports.js";
import { merchantKey, type ReceiptFacts } from "../src/rules/types.js";
import { DEFAULT_RULES } from "../src/rules/defaultRules.js";

let n = 0;
function r(o: Partial<ReceiptFacts>): ReceiptFacts {
  const merchant = o.merchant ?? "Amazon";
  return {
    id: `r${++n}`,
    merchant,
    merchantKey: merchantKey(merchant),
    amountCents: 6499,
    currency: "GBP",
    date: "2026-10-02",
    orderId: null,
    documentType: "payment_receipt",
    category: "shopping",
    isRecurring: false,
    flight: null,
    ...o,
  };
}

const dupCond = DEFAULT_RULES.find((x) => x.code === "duplicate_charge")!.conditions as never;
const subCond = DEFAULT_RULES.find((x) => x.code === "forgotten_subscription")!.conditions as never;
const NOW = new Date("2026-11-04T12:00:00Z");

describe("merchantKey", () => {
  it("treats store name variants as the same store", () => {
    expect(merchantKey("Amazon.co.uk")).toBe("amazon");
    expect(merchantKey("AMAZON UK LTD")).toBe("amazon");
    expect(merchantKey("The Gym Group plc")).toBe("gymgroup");
  });
});

describe("duplicate charges", () => {
  it("finds the same order charged twice (strong)", () => {
    const f = findDuplicates([r({ orderId: "A1" }), r({ orderId: "A1", date: "2026-10-03" })], dupCond);
    expect(f).toHaveLength(1);
    expect(f[0].details.confidence).toBe("strong");
    expect(f[0].expectedCents).toBe(6499);
  });

  it("does NOT flag an order confirmation plus its payment receipt", () => {
    const f = findDuplicates([r({ orderId: "A1", documentType: "order_confirmation" }), r({ orderId: "A1" })], dupCond);
    expect(f).toHaveLength(0);
  });

  it("ignores shipping and refund emails", () => {
    expect(findDuplicates([r({ documentType: "shipping_notice" }), r({ documentType: "shipping_notice" })], dupCond)).toHaveLength(0);
  });

  it("flags two identical separate orders as 'possible' and asks the user", () => {
    const f = findDuplicates([r({ orderId: "A1" }), r({ orderId: "A2" })], dupCond);
    expect(f[0].details.confidence).toBe("possible");
    expect(f[0].details.question).toMatch(/only mean to buy/);
  });

  it("does not flag different amounts, different stores, far-apart dates, food, or tiny amounts", () => {
    expect(findDuplicates([r({}), r({ amountCents: 6500 })], dupCond)).toHaveLength(0);
    expect(findDuplicates([r({}), r({ merchant: "eBay" })], dupCond)).toHaveLength(0);
    expect(findDuplicates([r({}), r({ date: "2026-10-20" })], dupCond)).toHaveLength(0);
    expect(findDuplicates([r({ category: "food" }), r({ category: "food" })], dupCond)).toHaveLength(0);
    expect(findDuplicates([r({ amountCents: 250 }), r({ amountCents: 250 })], dupCond)).toHaveLength(0);
  });

  it("uses each receipt in at most one finding", () => {
    expect(findDuplicates([r({ orderId: "A" }), r({ orderId: "A" }), r({ orderId: "A" })], dupCond)).toHaveLength(1);
  });
});

describe("forgotten subscriptions", () => {
  const sub = (date: string, o: Partial<ReceiptFacts> = {}) =>
    r({ merchant: "Netflix", amountCents: 1099, date, documentType: "subscription_charge", isRecurring: true, category: "subscription", ...o });

  it("finds a monthly subscription that is still charging", () => {
    const f = findSubscriptions([sub("2026-08-15"), sub("2026-09-15"), sub("2026-10-15")], subCond, NOW);
    expect(f).toHaveLength(1);
    expect(f[0].details.period).toBe("monthly");
    expect(f[0].expectedCents).toBe(1099);
    expect(f[0].reason).toMatch(/every month/);
    expect(f[0].dedupeKey).toBe("sub:netflix:GBP");
  });

  it("finds a yearly one", () => {
    const f = findSubscriptions([sub("2024-11-01", { amountCents: 9500 }), sub("2025-11-01", { amountCents: 9500 })], subCond, NOW);
    expect(f[0].details.period).toBe("yearly");
  });

  it("skips subscriptions that already stopped, irregular charges and single charges", () => {
    expect(findSubscriptions([sub("2026-03-01"), sub("2026-04-01")], subCond, NOW)).toHaveLength(0);
    expect(findSubscriptions([sub("2026-09-01"), sub("2026-10-20")], subCond, NOW)).toHaveLength(0);
    expect(findSubscriptions([sub("2026-10-15")], subCond, NOW)).toHaveLength(0);
  });
});

describe("airports and distance", () => {
  it("knows major airports and measures distance", () => {
    const lhr = airport("LHR")!;
    const jfk = airport("jfk")!;
    expect(lhr.country).toBe("GB");
    expect(distanceKm(lhr, jfk)).toBeGreaterThan(5500);
    expect(distanceKm(lhr, jfk)).toBeLessThan(5600);
    expect(airport("ZZZ")).toBeNull();
  });

  it("reads the airline from a flight number", () => {
    expect(carrierCode("BA117")).toBe("BA");
    expect(carrierCode("U2 8321")).toBe("U2");
    expect(carrierCode("1234")).toBeNull();
  });
});

describe("EU261 / UK261", () => {
  it("chooses the law by departure country, then by airline for arrivals", () => {
    expect(regimeFor("GB", "US", "BA")).toBe("UK261");
    expect(regimeFor("FR", "GB", "AF")).toBe("EU261");
    expect(regimeFor("US", "GB", "BA")).toBe("UK261");
    expect(regimeFor("US", "GB", "AA")).toBeNull(); // US airline into the UK: not covered
    expect(regimeFor("US", "DE", "LH")).toBe("EU261");
    expect(regimeFor("AE", "PK", "EK")).toBeNull();
  });

  it("works out the maximum amount by distance", () => {
    const longHaul = assessFlight({ flightNumber: "BA117", departure: "LHR", arrival: "JFK", scheduledDeparture: "2026-10-01T11:20:00Z" }, NOW, 6)!;
    expect(longHaul).toMatchObject({ regime: "UK261", band: 2, maxAmount: 520, currency: "GBP" });
    const short = assessFlight({ flightNumber: "AF1680", departure: "CDG", arrival: "LHR", scheduledDeparture: "2026-10-01T08:00:00Z" }, NOW, 3)!;
    expect(short).toMatchObject({ regime: "EU261", band: 0, maxAmount: 250, currency: "EUR" });
    // Inside the EU and over 3,500 km stays in the middle band.
    const canary = assessFlight({ flightNumber: "FR1", departure: "HEL", arrival: "TFS", scheduledDeparture: "2026-10-01T08:00:00Z" }, NOW, 3)!;
    expect(canary.distanceKm).toBeGreaterThan(3500);
    expect(canary.maxAmount).toBe(400);
  });

  it("skips future flights and flights past the time limit", () => {
    expect(assessFlight({ flightNumber: "BA1", departure: "LHR", arrival: "JFK", scheduledDeparture: "2026-12-01T10:00:00Z" }, NOW, 6)).toBeNull();
    expect(assessFlight({ flightNumber: "LH1", departure: "FRA", arrival: "JFK", scheduledDeparture: "2022-01-01T10:00:00Z" }, NOW, 3)).toBeNull();
  });

  it("pays only for real delays and short-notice cancellations", () => {
    const a = { regime: "UK261" as const, band: 2 as const };
    expect(compensation(a, { outcome: "delayed", arrivalDelayMinutes: 170 })).toBe(0);
    expect(compensation(a, { outcome: "delayed", arrivalDelayMinutes: 200 })).toBe(260); // halved for 3–4h on long haul
    expect(compensation(a, { outcome: "delayed", arrivalDelayMinutes: 300 })).toBe(520);
    expect(compensation(a, { outcome: "cancelled", noticeDays: 3 })).toBe(520);
    expect(compensation(a, { outcome: "cancelled", noticeDays: 20 })).toBe(0);
    expect(compensation(a, { outcome: "on_time" })).toBe(0);
    expect(compensation({ regime: "EU261", band: 1 }, { outcome: "delayed", arrivalDelayMinutes: 200 })).toBe(400);
  });

  it("counts the same flight once even if several emails mention it", () => {
    const flight = { airline: "British Airways", flight_number: "BA117", departure_airport: "LHR", arrival_airport: "JFK", scheduled_departure: "2026-10-01T11:20:00Z" };
    const f = findFlights([r({ flight, documentType: "booking_confirmation" }), r({ flight, documentType: "other" })], { regime: "UK261", maxAgeYears: 6 }, NOW);
    expect(f).toHaveLength(1);
    expect(f[0].expectedCents).toBeNull();
    expect(f[0].details.needsInput).toBe("flight_outcome");
  });
});
