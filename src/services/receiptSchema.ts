// The exact shape we accept from the AI receipt reader.
// The AI is asked for this shape, and its answer is checked against it BEFORE anything
// is saved (SPEC.md: "Always validate the JSON before saving").
import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "must be a real date");

// What kind of document this is. The duplicate-charge rule only compares real charges,
// so an order confirmation and its shipping email are never mistaken for a double charge.
export const DOCUMENT_TYPES = [
  "payment_receipt",
  "order_confirmation",
  "invoice",
  "subscription_charge",
  "booking_confirmation",
  "shipping_notice",
  "refund_notice",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const money = z.number().finite().nonnegative().max(1_000_000);

export const receiptItemSchema = z.object({
  name: z.string().trim().min(1).max(300),
  quantity: z.number().positive().max(10_000).nullable(),
  unit_price: money.nullable(),
  total: money.nullable(),
});

// Airport codes must be 3-letter IATA codes. Anything else (e.g. "London Heathrow") becomes null
// rather than failing the whole receipt; the flight rule then simply skips it.
const iata = z.preprocess(
  (v) => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null),
  z.string().nullable(),
);

export const flightSchema = z.object({
  airline: z.string().trim().max(100).nullable(),
  flight_number: z
    .string()
    .trim()
    .max(20)
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .nullable(),
  departure_airport: iata,
  arrival_airport: iata,
  scheduled_departure: z
    .string()
    .trim()
    .max(40)
    .refine((d) => !Number.isNaN(Date.parse(d)), "must be a date-time")
    .nullable(),
});

export const parsedReceiptSchema = z.object({
  is_receipt: z.boolean(),
  merchant: z.string().trim().min(1).max(200).nullable(),
  total_amount: money.nullable(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 code")
    .nullable(),
  purchase_date: isoDate.nullable(),
  order_id: z.string().trim().max(120).nullable(),
  category: z.enum(["shopping", "subscription", "flight", "travel_other", "food", "utilities", "other"]),
  document_type: z.enum(DOCUMENT_TYPES),
  is_recurring: z.boolean(),
  items: z.array(receiptItemSchema).max(200),
  flight: flightSchema.nullable(),
});

export type ParsedReceipt = z.infer<typeof parsedReceiptSchema>;

/** JSON Schema given to the AI so it answers in exactly this shape (tool input). */
export const receiptJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "is_receipt",
    "merchant",
    "total_amount",
    "currency",
    "purchase_date",
    "order_id",
    "category",
    "document_type",
    "is_recurring",
    "items",
    "flight",
  ],
  properties: {
    is_receipt: { type: "boolean", description: "true only if this is a receipt, invoice, order confirmation or booking" },
    merchant: { type: ["string", "null"], description: "Store, service or airline name" },
    total_amount: { type: ["number", "null"], description: "Final amount charged, as a number without currency symbol" },
    currency: { type: ["string", "null"], description: "ISO 4217 code such as USD, GBP, EUR" },
    purchase_date: { type: ["string", "null"], description: "Purchase or charge date as YYYY-MM-DD" },
    order_id: { type: ["string", "null"], description: "Order, invoice, booking or confirmation number" },
    category: { type: "string", enum: ["shopping", "subscription", "flight", "travel_other", "food", "utilities", "other"] },
    document_type: {
      type: "string",
      enum: [...DOCUMENT_TYPES],
      description:
        "payment_receipt = money was taken; order_confirmation = order placed; subscription_charge = a renewal charge; booking_confirmation = travel booking; shipping_notice and refund_notice take no money",
    },
    is_recurring: { type: "boolean", description: "true if this is a repeating subscription or membership charge" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quantity", "unit_price", "total"],
        properties: {
          name: { type: "string" },
          quantity: { type: ["number", "null"] },
          unit_price: { type: ["number", "null"] },
          total: { type: ["number", "null"] },
        },
      },
    },
    flight: {
      type: ["object", "null"],
      description: "Only for flight bookings or boarding passes, otherwise null",
      additionalProperties: false,
      required: ["airline", "flight_number", "departure_airport", "arrival_airport", "scheduled_departure"],
      properties: {
        airline: { type: ["string", "null"] },
        flight_number: { type: ["string", "null"] },
        departure_airport: { type: ["string", "null"], description: "IATA code, e.g. LHR" },
        arrival_airport: { type: ["string", "null"], description: "IATA code, e.g. JFK" },
        scheduled_departure: { type: ["string", "null"], description: "ISO 8601 date-time if known" },
      },
    },
  },
};
