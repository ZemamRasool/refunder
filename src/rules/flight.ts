// Flight delay / cancellation compensation: EU261 and UK261.
//
// Who is covered:
//   EU261 — any flight departing an EU/EEA/Swiss airport, or arriving there from outside on an EU airline.
//   UK261 — any flight departing a UK airport, or arriving in the UK on a UK or EU airline.
// How much (per passenger), by flight distance:
//                      ≤1,500 km    1,500–3,500 km*    >3,500 km
//   EU261                €250            €400             €600
//   UK261                £220            £350             £520
//   * flights inside the EU (or inside the UK) over 1,500 km are always in the middle band.
// When: arrival 3+ hours late, or cancelled with less than 14 days' notice.
//   For >3,500 km flights arriving 3–4 hours late the amount is halved.
// Not covered: "extraordinary circumstances" (e.g. severe weather, air traffic control strikes).
//   The airline decides that; we mention it in the claim letter.
import { airport, carrierCode, distanceKm, EU261_COUNTRIES, EU_CARRIERS, UK_CARRIERS } from "./airports.js";

export type Regime = "EU261" | "UK261";

export interface FlightFacts {
  flightNumber: string | null;
  departure: string | null;
  arrival: string | null;
  scheduledDeparture: string | null; // ISO date-time
}

export interface FlightAssessment {
  regime: Regime;
  flightNumber: string | null;
  carrier: string | null;
  departure: string;
  arrival: string;
  flightDate: string; // YYYY-MM-DD
  distanceKm: number;
  band: 0 | 1 | 2;
  currency: "EUR" | "GBP";
  maxAmount: number;
}

const AMOUNTS: Record<Regime, [number, number, number]> = { EU261: [250, 400, 600], UK261: [220, 350, 520] };

/** Which law covers this flight, preferring the departure country's law. */
export function regimeFor(depCountry: string, arrCountry: string, carrier: string | null): Regime | null {
  const depEU = EU261_COUNTRIES.has(depCountry);
  const arrEU = EU261_COUNTRIES.has(arrCountry);
  const depUK = depCountry === "GB";
  const arrUK = arrCountry === "GB";
  if (depEU) return "EU261";
  if (depUK) return "UK261";
  if (arrEU && carrier && EU_CARRIERS.has(carrier)) return "EU261";
  if (arrUK && carrier && (UK_CARRIERS.has(carrier) || EU_CARRIERS.has(carrier))) return "UK261";
  return null;
}

export function bandFor(regime: Regime, km: number, depCountry: string, arrCountry: string): 0 | 1 | 2 {
  const inside =
    regime === "EU261"
      ? EU261_COUNTRIES.has(depCountry) && EU261_COUNTRIES.has(arrCountry)
      : depCountry === "GB" && arrCountry === "GB";
  if (km <= 1500) return 0;
  if (km <= 3500 || inside) return 1;
  return 2;
}

export function assessFlight(f: FlightFacts, now: Date, maxAgeYears: number): FlightAssessment | null {
  const dep = airport(f.departure);
  const arr = airport(f.arrival);
  if (!dep || !arr || dep.code === arr.code || !f.scheduledDeparture) return null;

  const when = new Date(f.scheduledDeparture);
  if (Number.isNaN(when.getTime())) return null;
  // Only flights that have already happened, and are still inside the claim time limit.
  if (when.getTime() > now.getTime() - 3 * 60 * 60 * 1000) return null;
  const oldest = new Date(now);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - maxAgeYears);
  if (when < oldest) return null;

  const carrier = carrierCode(f.flightNumber);
  const regime = regimeFor(dep.country, arr.country, carrier);
  if (!regime) return null;

  const km = distanceKm(dep, arr);
  const band = bandFor(regime, km, dep.country, arr.country);
  return {
    regime,
    flightNumber: f.flightNumber,
    carrier,
    departure: dep.code,
    arrival: arr.code,
    flightDate: when.toISOString().slice(0, 10),
    distanceKm: km,
    band,
    currency: regime === "EU261" ? "EUR" : "GBP",
    maxAmount: AMOUNTS[regime][band],
  };
}

export type FlightOutcome =
  | { outcome: "delayed"; arrivalDelayMinutes: number }
  | { outcome: "cancelled"; noticeDays: number }
  | { outcome: "on_time" };

/** Compensation for what actually happened. 0 means not eligible. */
export function compensation(a: Pick<FlightAssessment, "regime" | "band">, what: FlightOutcome): number {
  const full = AMOUNTS[a.regime][a.band];
  if (what.outcome === "on_time") return 0;
  if (what.outcome === "cancelled") return what.noticeDays < 14 ? full : 0;
  if (what.arrivalDelayMinutes < 180) return 0;
  if (a.band === 2 && what.arrivalDelayMinutes < 240) return full / 2;
  return full;
}
