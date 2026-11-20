// Every user gets a private, hard-to-guess email address for forwarding receipts,
// for example "k7q2m9xw4t@in.refundradar.app". Anything sent there is filed under that user.
import { randomBytes } from "node:crypto";

// Lowercase letters and digits, without look-alikes (0/o, 1/l/i).
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newForwardingKey(length = 10): string {
  const bytes = randomBytes(length);
  let key = "";
  for (let i = 0; i < length; i++) key += ALPHABET[bytes[i] % ALPHABET.length];
  return key;
}

export function forwardingAddress(key: string, domain: string): string {
  return `${key}@${domain}`;
}

/** Pull the user's key out of a recipient address, if it belongs to our inbound domain. */
export function keyFromAddress(address: string, domain: string): string | null {
  const match = /<?([^<>\s@]+)@([^<>\s@]+)>?/.exec(address.trim().toLowerCase());
  if (!match || match[2] !== domain.toLowerCase()) return null;
  return /^[a-z0-9]{6,32}$/.test(match[1]) ? match[1] : null;
}
