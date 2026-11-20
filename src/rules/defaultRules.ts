// The starting set of claim rules, saved into the claim_rules table on startup.
// Admins can switch rules off (e.g. low success rate); existing rows are never overwritten.
//
// templateText is the base for the claim letter. {{placeholders}} are filled from the claim facts.
import type { ClaimType } from "../generated/prisma/client.js";
import type { Db } from "../lib/prisma.js";
import type { DuplicateConditions } from "./duplicate.js";
import type { SubscriptionConditions } from "./subscription.js";

export interface RuleDefinition {
  code: string;
  name: string;
  type: ClaimType;
  country: string;
  conditions: Record<string, unknown>;
  templateText: string;
}

export const DEFAULT_RULES: RuleDefinition[] = [
  {
    code: "duplicate_charge",
    name: "Duplicate charge",
    type: "duplicate_charge",
    country: "*",
    conditions: { windowDays: 3, minAmountCents: 300 } satisfies DuplicateConditions,
    templateText: `Subject: Duplicate charge on order {{order_id}}

Hello {{merchant}} support team,

I was charged {{amount}} twice: on {{dates}} (order reference(s): {{order_ids}}). I only made one purchase.
Please refund the duplicate charge of {{amount}} to my original payment method.
I have attached copies of both receipts.

Please confirm the refund within 14 days.

Kind regards,
{{customer_email}}`,
  },
  {
    code: "forgotten_subscription",
    name: "Forgotten subscription",
    type: "forgotten_subscription",
    country: "*",
    conditions: {
      minCharges: 2,
      monthlyDays: [26, 35],
      yearlyDays: [350, 380],
      activeWithinDays: { monthly: 45, yearly: 400 },
    } satisfies SubscriptionConditions,
    templateText: `Subject: Cancel my subscription and refund the last charge

Hello {{merchant}} support team,

Please cancel my subscription linked to {{customer_email}} with immediate effect.
I have not used the service, and I was charged {{amount}} on {{last_date}}.
As the service was not used during this period, please refund this last charge to my original payment method.

Please confirm the cancellation and the refund in writing.

Kind regards,
{{customer_email}}`,
  },
  {
    code: "eu261",
    name: "Flight delay / cancellation (EU261)",
    type: "flight_compensation",
    country: "EU",
    conditions: { regime: "EU261", maxAgeYears: 3 },
    templateText: `Subject: EU261 compensation claim — flight {{flight_number}} on {{flight_date}}

Dear {{airline}} customer relations,

I was a passenger on flight {{flight_number}} from {{departure}} to {{arrival}} on {{flight_date}}, booking reference {{order_id}}.
{{what_happened}}

Under Regulation (EC) No 261/2004, the flight distance of {{distance_km}} km entitles me to compensation of {{amount}}.
Please pay this compensation within 28 days. If you believe extraordinary circumstances apply, please give the specific reason and evidence.

Kind regards,
{{customer_email}}`,
  },
  {
    code: "uk261",
    name: "Flight delay / cancellation (UK261)",
    type: "flight_compensation",
    country: "GB",
    conditions: { regime: "UK261", maxAgeYears: 6 },
    templateText: `Subject: UK261 compensation claim — flight {{flight_number}} on {{flight_date}}

Dear {{airline}} customer relations,

I was a passenger on flight {{flight_number}} from {{departure}} to {{arrival}} on {{flight_date}}, booking reference {{order_id}}.
{{what_happened}}

Under Regulation (EC) No 261/2004 as retained in UK law (UK261), the flight distance of {{distance_km}} km entitles me to compensation of {{amount}}.
Please pay this compensation within 28 days. If you believe extraordinary circumstances apply, please give the specific reason and evidence.

Kind regards,
{{customer_email}}`,
  },
];

export async function ensureDefaultRules(prisma: Db): Promise<void> {
  for (const r of DEFAULT_RULES) {
    await prisma.claimRule.upsert({
      where: { code: r.code },
      update: {},
      create: {
        code: r.code,
        name: r.name,
        type: r.type,
        country: r.country,
        conditionsJson: r.conditions as object,
        templateText: r.templateText,
      },
    });
  }
}
