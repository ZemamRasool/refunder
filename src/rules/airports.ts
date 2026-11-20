// Airport locations (IATA code → latitude, longitude, country) and flight distance.
// Data: data/airports.csv, built from the open mwgg/Airports dataset (MIT licence).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Airport {
  code: string;
  lat: number;
  lon: number;
  country: string; // ISO 3166-1 alpha-2
}

let cache: Map<string, Airport> | null = null;

function load(): Map<string, Airport> {
  if (cache) return cache;
  // Works from both src/rules (dev) and dist/rules (built): the data folder is two levels up.
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "airports.csv");
  const map = new Map<string, Airport>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [code, lat, lon, country] = line.trim().split(",");
    if (code && country) map.set(code, { code, lat: Number(lat), lon: Number(lon), country });
  }
  cache = map;
  return map;
}

export function airport(code: string | null | undefined): Airport | null {
  if (!code) return null;
  return load().get(code.toUpperCase()) ?? null;
}

/** Great-circle distance in km (the method EU261 uses). */
export function distanceKm(a: Airport, b: Airport): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// Countries where EU261 applies: EU members, their outermost regions, plus Iceland, Norway, Liechtenstein, Switzerland.
export const EU261_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "GP", "GF", "MQ", "RE", "YT", "MF",
  "IS", "NO", "LI", "CH",
]);

// Airlines licensed in the EU/EEA/CH (IATA codes), for flights INTO the EU from outside.
export const EU_CARRIERS = new Set([
  "LH", "AF", "KL", "IB", "AZ", "SK", "AY", "EI", "FR", "RK", "TP", "LX", "OS", "SN", "LO", "A3", "OA", "VY",
  "W6", "W4", "DY", "D8", "EW", "DE", "X3", "HV", "TO", "EN", "BT", "OU", "RO", "FB", "LG", "UX", "V7", "DS",
  "EC", "I2", "NT", "YW", "WK", "4Y", "SM", "JP", "OK", "BJ", "2L", "WF", "FI", "PM",
]);

// Airlines licensed in the UK, for UK261 flights INTO the UK.
export const UK_CARRIERS = new Set(["BA", "VS", "U2", "LS", "BY", "W9", "T3", "LM", "MT", "ZT", "GR", "ZB"]);

/** "BA117" → "BA", "U2 8321" → "U2". Returns null for formats we can't read. */
export function carrierCode(flightNumber: string | null | undefined): string | null {
  if (!flightNumber) return null;
  const m = /^([A-Z0-9]{2})(\d{1,4})[A-Z]?$/.exec(flightNumber.replace(/\s+/g, "").toUpperCase());
  if (!m || /^\d{2}$/.test(m[1])) return null;
  return m[1];
}
