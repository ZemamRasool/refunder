# SPEC.md — RefundRadar

> Source: "Three Startup Build Specs" (4 November 2026), Project 1 plus the shared rules.

# Project 1: Refund Finder (RefundRadar)

**Working name:** RefundRadar

**One-line pitch:** "We find money you are owed and claim it for you. You pay nothing unless we recover it."

**Memorable line:** *We are a metal detector for money you forgot you lost.*

## The problem

People lose money in small amounts they never chase: a late delivery, a price drop after buying, a duplicate charge, a subscription they forgot, a delayed flight. Each claim takes 20 to 60 minutes, so nobody bothers.

## Who pays

Online shoppers and travelers in countries with strong consumer protection (US, UK, EU, Canada, Australia). Start with **one country**.

## Business model

Take **20 to 30 percent of the money recovered**. No recovery means no fee.

## MVP scope (build only this)

Three claim types:

1.  **Duplicate or wrong charges** found in receipts.

2.  **Forgotten subscriptions** (charges that repeat for services the user does not use).

3.  **Flight delay or cancellation compensation** (for example the EU261 rule in Europe).

**Do NOT build yet:** mobile app, bank connections, price-drop tracking for every store, automatic claim sending, chat support.

## How receipts get in

Gmail "read all email" permission needs a long Google security review for public apps. So start with simpler options:

- **Forwarding address:** each user gets a private address like u123@refundradar.app. They forward receipts to it.

- **Upload:** user uploads a receipt screenshot or PDF.

- **Gmail connection (later):** use up to 100 test users first, then do Google's review only after you have proof people want it.

## User flow

1.  User signs up and forwards or uploads receipts.

2.  AI reads each receipt and pulls out: store, amount, date, order number, items.

3.  The rules engine checks every receipt against the claim types.

4.  User sees a list: "You may be owed \$48. Here is why."

5.  User taps **Approve**. The app writes the claim message or form text.

6.  In the MVP, **you or the user send the claim manually.** Automation comes later.

7.  When money arrives, the user confirms, and the fee is charged.

## Data model (tables)

- users (id, email, country, created_at)

- receipts (id, user_id, source, raw_file_url, merchant, amount, currency, purchase_date, order_id, parsed_json)

- claim_rules (id, type, country, conditions_json, template_text, success_rate)

- claims (id, receipt_id, rule_id, status: found / approved / sent / won / lost, expected_amount, recovered_amount)

- payouts (id, claim_id, fee_percent, fee_amount, paid_at)

## Technical pieces

- **Receipt reading:** send the receipt text or image to an AI model API and ask for JSON with a fixed set of fields. Always validate the JSON before saving.

- **Rules engine:** plain code, not AI. AI reads the receipt, rules decide the claim. This keeps results predictable.

- **Background jobs:** a queue (BullMQ with Redis) so receipt processing does not block the website.

- **Claim text:** AI writes a polite, firm message from a template, and the user can edit it.

- **Fee collection:** save a payment method at signup and charge the fee only after the user confirms recovery.

## Risks and honest answers

- **Trust:** people hesitate to share email. Answer: forwarding address, clear promise that you only read receipts, and delete raw files after 30 days.

- **Fee dodging:** users may recover money and not tell you. Answer: card on file, and a clear agreement at signup.

- **Claims rejected:** track the success rate per rule and drop the weak ones.

## Validation test (one week, almost no code)

1.  Build a one-page website with an email form.

2.  Ask 5 friends or family in the target country to forward their last 3 months of receipts.

3.  **Search them by hand** and count the real dollars you find.

4.  Goal: at least \$300 found across 5 people, and at least 2 of them willing to approve a claim.

## Milestones

- **Milestone 1 (week 1):** landing page, signup, forwarding address, receipt upload, AI receipt reader saving JSON.

- **Milestone 2 (week 2):** rules engine for the three claim types, results page.

- **Milestone 3 (week 3):** claim text generator, claim tracker with statuses.

- **Milestone 4 (week 4):** payments, fee charging, admin dashboard for you.

## Starter prompt for Claude

> I am building RefundRadar: users forward receipts, AI extracts the data, a rules engine finds refunds they are owed, and we take a percentage of recovered money. Use Node.js, Express, PostgreSQL with Prisma, and a simple web front end. Read SPEC.md. Build Milestone 1 only: project setup in Docker, database schema, signup with Firebase Authentication, receipt upload, and an endpoint that sends a receipt to an AI model and saves validated JSON. Explain each file in simple words and write tests.


# Shared rules

- **Default stack:** Node.js + Express, PostgreSQL (Neon) with Prisma ORM, Firebase Authentication, Docker, and a web front end first (Flutter mobile later, only after people use the web version).

- **MVP (Minimum Viable Product):** the smallest version that proves people want it. Cut every feature that does not help prove that.

- **Payments warning:** Stripe does not open business accounts in Pakistan. Check this in week one. Options: a US company via Stripe Atlas, Paddle or Lemon Squeezy (they act as the seller for you), or Wise and Payoneer for payouts. Do not build payments until this is solved.

- **Security basics:** encrypt secrets, never store passwords yourself, keep one customer's data fully separate from another's, log who accessed what.

- **Legal basics:** write a privacy policy and terms of service before real users arrive. Talk to a lawyer before handling other people's money, emails, or employee data.

