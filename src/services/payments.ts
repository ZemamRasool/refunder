// Fee collection (Milestone 4).
//
// SPEC.md warns: Stripe does not open accounts for Pakistani businesses. So there are two providers:
//   manual — works today. After a win, the fee is recorded and shown in the admin dashboard;
//            you invoice the customer (Payoneer, Wise, bank transfer) and mark it paid.
//   stripe — for when you have a Stripe account (e.g. a US company via Stripe Atlas).
//            Card saved at signup through Stripe Checkout; fee charged automatically after a win.
// Card numbers never touch our server: Stripe hosts the card form.
import Stripe from "stripe";
import type { Payout, User } from "../generated/prisma/client.js";
import type { Db } from "../lib/prisma.js";
import { toMinorUnits, toCents } from "../lib/money.js";

export interface ChargeResult {
  status: "pending" | "processing" | "paid" | "failed";
  providerRef?: string;
  failureReason?: string;
}

export interface PaymentProvider {
  name: "manual" | "stripe";
  /** Start saving a payment method. Returns a URL to send the user to, or ready=true if nothing is needed. */
  setupPaymentMethod(user: User): Promise<{ url?: string; ready: boolean; message?: string }>;
  chargeFee(payout: Payout, user: User): Promise<ChargeResult>;
  /** Payment provider calls us back (Stripe webhooks). */
  handleWebhook?(rawBody: Buffer, signature: string): Promise<{ handled: boolean }>;
}

const EUR_COUNTRIES = new Set(["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"]);
export function currencyForCountry(country: string | null): string {
  if (country === "GB") return "gbp";
  if (country === "CA") return "cad";
  if (country === "AU") return "aud";
  if (country && EUR_COUNTRIES.has(country)) return "eur";
  return "usd";
}

export function createManualProvider(): PaymentProvider {
  return {
    name: "manual",
    async setupPaymentMethod() {
      return { ready: true, message: "No card needed now. After a successful claim we'll send you an invoice for our fee." };
    },
    async chargeFee() {
      return { status: "pending" };
    },
  };
}

export function createStripeProvider(prisma: Db, opts: { secretKey: string; webhookSecret: string; baseUrl: string }): PaymentProvider {
  const stripe = new Stripe(opts.secretKey);

  async function customerFor(user: User): Promise<string> {
    if (user.paymentCustomerId) return user.paymentCustomerId;
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
    await prisma.user.update({ where: { id: user.id }, data: { paymentCustomerId: customer.id } });
    return customer.id;
  }

  return {
    name: "stripe",

    async setupPaymentMethod(user) {
      const customer = await customerFor(user);
      const session = await stripe.checkout.sessions.create({
        mode: "setup",
        customer,
        allowed_payment_method_types: ["card"],
        // Setup mode needs a currency to decide which card types to offer.
        currency: currencyForCountry(user.country),
        success_url: `${opts.baseUrl}/app?billing=done`,
        cancel_url: `${opts.baseUrl}/app?billing=cancelled`,
        metadata: { userId: user.id },
      });
      return { url: session.url ?? undefined, ready: false };
    },

    async chargeFee(payout, user) {
      if (!user.paymentCustomerId || !user.paymentMethodReady) return { status: "failed", failureReason: "No saved payment method" };
      const customer = await stripe.customers.retrieve(user.paymentCustomerId);
      if (customer.deleted) return { status: "failed", failureReason: "Payment customer was deleted" };
      const pm = customer.invoice_settings?.default_payment_method;
      const paymentMethod = typeof pm === "string" ? pm : pm?.id;
      if (!paymentMethod) return { status: "failed", failureReason: "No default payment method" };
      try {
        const intent = await stripe.paymentIntents.create(
          {
            amount: toMinorUnits(toCents(payout.feeAmount), payout.currency),
            currency: payout.currency.toLowerCase(),
            customer: user.paymentCustomerId,
            payment_method: paymentMethod,
            off_session: true,
            confirm: true,
            description: `RefundRadar fee for claim ${payout.claimId}`,
            metadata: { payoutId: payout.id, claimId: payout.claimId, userId: user.id },
          },
          // Same payout is never charged twice, even if this runs again.
          { idempotencyKey: `payout-${payout.id}` },
        );
        if (intent.status === "succeeded") return { status: "paid", providerRef: intent.id };
        if (intent.status === "processing") return { status: "processing", providerRef: intent.id };
        return { status: "failed", providerRef: intent.id, failureReason: `Payment needs attention (${intent.status})` };
      } catch (err) {
        const message = err instanceof Stripe.errors.StripeError ? err.message : "Payment failed";
        return { status: "failed", failureReason: message.slice(0, 300) };
      }
    },

    async handleWebhook(rawBody, signature) {
      // Rejects anything not signed by Stripe with our webhook secret.
      const event = stripe.webhooks.constructEvent(rawBody, signature, opts.webhookSecret);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        if (session.mode !== "setup" || !session.setup_intent || !session.customer) return { handled: false };
        const setupIntentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent.id;
        const customerId = typeof session.customer === "string" ? session.customer : session.customer.id;
        const si = await stripe.setupIntents.retrieve(setupIntentId);
        const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
        if (!pm) return { handled: false };
        await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm } });
        await prisma.user.updateMany({ where: { paymentCustomerId: customerId }, data: { paymentMethodReady: true } });
        return { handled: true };
      }

      if (event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed") {
        const intent = event.data.object;
        const payoutId = intent.metadata?.payoutId;
        if (!payoutId) return { handled: false };
        await prisma.payout.updateMany({
          where: { id: payoutId, status: { in: ["pending", "processing", "failed"] } },
          data:
            event.type === "payment_intent.succeeded"
              ? { status: "paid", paidAt: new Date(), providerRef: intent.id, failureReason: null }
              : { status: "failed", providerRef: intent.id, failureReason: intent.last_payment_error?.message?.slice(0, 300) ?? "Payment failed" },
        });
        return { handled: true };
      }

      return { handled: false };
    },
  };
}
