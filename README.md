# RefundRadar

**We find money you are owed and claim it for you. You pay nothing unless we recover it.**

Users forward or upload receipts. An AI reads them. Fixed rules (plain code, not AI) find money the user is owed. The user approves a claim and gets a ready-to-send letter. When the money arrives, we charge a percentage. Built to `SPEC.md`, Milestones 1–4.

## What it does

| | |
|---|---|
| **Receipts in** | Private forwarding address per user (`k7q2m9xw4t@in.refundradar.app`), or upload of photos, PDFs and text. The same receipt sent twice is counted once. |
| **AI reader** | Gemini reads store, amount, date, order number, items, document type and flight details. The answer is **validated before saving**; bad answers are rejected. Runs in the background, so the website never waits. Temporary AI errors are retried. |
| **Rules engine** | Plain code, same answer every time. **Duplicate charges** (same order charged twice, or two identical orders the user confirms were a mistake). **Forgotten subscriptions** (regular monthly/yearly charges that are still running). **Flight delays/cancellations** under **EU261 and UK261**, with the exact amount by distance (€250/400/600, £220/350/520), the 50% long-haul rule, carrier rules and time limits. |
| **Results page** | "You may be owed £408.99. Here is why." Each finding explains itself in plain words. |
| **Claim letters** | The AI writes a polite, firm letter from the rule's template; the amount is checked to make sure the AI kept it. If the AI is unavailable, the filled template is used. The user can edit it. Nothing is sent automatically (SPEC: manual sending in the MVP). |
| **Claim tracker** | found → approved → sent → won / lost, or dismissed. Dismissed findings never come back. |
| **Fees** | On a win: fee = recovered × 25% (configurable 20–30%), rounded to the cent. **Manual** mode (works from Pakistan today): you invoice and mark paid in admin. **Stripe** mode: card saved at signup, fee charged automatically after a win. |
| **Admin dashboard** (`/admin`) | Users, receipts, claims, money recovered, fees paid/outstanding. Rule success rates (won ÷ (won + lost)), with an on/off switch to drop weak rules. Mark fees paid, waive, retry. Failed background jobs. Audit log. |
| **Niche** | Launches in one country (`LAUNCH_COUNTRIES=GB` by default). People from elsewhere go to the waitlist automatically. |

## Security

- **No passwords stored.** Login is Firebase (email link or Google). Tokens are checked on every request; unverified emails are refused.
- **Encryption at rest.** Receipt files and email text are encrypted with AES-256-GCM (`ENCRYPTION_KEY`). A copied uploads folder or database dump can't be read.
- **Customers fully separated.** Every database query includes the user's id. Tests check that one user can't see or change another's receipts or claims.
- **Audit log.** Sign-ups, uploads, every claim action, terms acceptance, exports, deletions, and **every admin request** (including denied attempts) are logged.
- **Admins** are only the emails in `ADMIN_EMAILS`.
- **Uploads** are checked by their real contents (a renamed `.exe` is refused), limited in size, and stored with random names.
- **Headers:** strict Content-Security-Policy (no inline scripts), no framing, nosniff, HSTS in production.
- **Rate limits** on the API, signups, uploads and webhooks.
- **Webhooks:** inbound email needs a secret token (checked in constant time); Stripe webhooks are signature-verified.
- **Payments:** card numbers never touch our server (Stripe hosts the form). Charges use an idempotency key, so a fee can't be charged twice.
- **AI safety:** receipts are treated as data, not instructions; AI output must pass strict validation.
- **Trust promises:** raw files and email text are deleted after 30 days; users can download all their data or delete their account.
- **Production checks:** the server refuses to start in production with dev login, a short webhook token, a missing AI key, or a non-https URL.

---

## Run it on your computer

You need **Node 22** and **Docker Desktop**.

> If you ran the earlier Milestone-1 version, reset its database once: `docker compose down -v`

```bash
cd refundradar
copy .env.example .env           # Mac/Linux: cp .env.example .env
npm install
npm run gen:key                  # copy the output into .env as ENCRYPTION_KEY=...
docker compose up -d db          # starts PostgreSQL
npx prisma generate              # builds the database client
npx prisma migrate deploy        # creates the tables
npm run dev                      # http://localhost:3000
```

In `.env`, also set:
- `GEMINI_API_KEY=...` (aistudio.google.com) so receipts are actually read.
- `ADMIN_EMAILS=you@example.com` to open `/admin`.

`AUTH_MODE=dev` lets you log in with any email, for local testing only.

### Try it with the real AI

1. Open http://localhost:3000/app, log in with your email, and choose United Kingdom.
2. **Receipts** tab: upload 2–3 real receipts or order emails (PDF, screenshot or a saved `.txt`), for example an online order, a Netflix/Spotify charge, a flight booking.
3. Wait a few seconds. Receipts change from *pending* to *parsed*.
4. **Money found** tab: see the findings, answer the questions, approve one and read the letter.
5. Open http://localhost:3000/admin to see it from your side.

### Run the tests

```bash
docker compose exec db createdb -U refundradar refundradar_test
```
Windows (PowerShell):
```powershell
$env:DATABASE_URL="postgresql://refundradar:refundradar@localhost:5432/refundradar_test"; npx prisma migrate deploy
Remove-Item Env:DATABASE_URL
npm test
```
Mac/Linux: `DATABASE_URL=postgresql://refundradar:refundradar@localhost:5432/refundradar_test npx prisma migrate deploy && npm test`

73 tests cover validation, rules, EU261/UK261 maths, encryption, privacy between users, the claim flow, fees, admin access, the audit log, webhooks, data export and deletion, and the 30-day cleanup. They use a fake AI, so they cost nothing.

### Run everything in Docker

```bash
docker compose up --build
```

---

## Going live

### 1. Real login (Firebase)
1. Go to console.firebase.google.com and create a project. Under **Authentication → Sign-in method**, enable **Email link (passwordless)** and **Google**.
2. Under **Project settings → General → Your apps**, add a Web app. Copy `apiKey` into `FIREBASE_WEB_API_KEY` and `authDomain` into `FIREBASE_WEB_AUTH_DOMAIN`.
3. Under **Project settings → Service accounts**, click **Generate new private key**. Copy `project_id`, `client_email` and `private_key` into the `FIREBASE_*` settings. Keep the key on one line with `\n`, in quotes. **Never commit this.**
4. Under **Authentication → Settings → Authorized domains**, add your domain. Then set `AUTH_MODE=firebase`.

### 2. Forwarding address (Postmark inbound)
1. Choose a domain (e.g. `refundradar.app`). In Postmark, create a server with an **Inbound** stream.
2. Add an MX record for `in.refundradar.app` pointing to `inbound.postmarkapp.com`.
3. Set the inbound webhook URL to `https://YOUR-SITE/webhooks/inbound-email?token=YOUR_TOKEN`. Put the same token in `INBOUND_WEBHOOK_TOKEN` (24+ random characters).

### 3. Payments
- **Now (Pakistan):** keep `PAYMENT_PROVIDER=manual`. After each win, the fee appears in `/admin → Fees`. Invoice the customer (Payoneer, Wise, bank transfer), then press **Mark paid**.
- **Later (Stripe via a US company, e.g. Stripe Atlas):** set `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, and a webhook at `https://YOUR-SITE/webhooks/stripe` for `checkout.session.completed`, `payment_intent.succeeded` and `payment_intent.payment_failed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`. Users then add a card in Settings before approving claims.

### 4. Production settings
`NODE_ENV=production`, `PUBLIC_BASE_URL=https://...`, a fresh `ENCRYPTION_KEY` (**back it up**: without it, stored files can't be read), and a managed Postgres such as Neon. Run behind HTTPS. For more traffic, set `WORKER_INLINE=false` and run `npm run worker` as a separate process.

### 5. Before real users (SPEC.md legal basics)
`/terms` and `/privacy` are plain-language **drafts** with a visible "pending legal review" notice. Have a lawyer review them (UK GDPR, and the fee agreement), then remove the notice. Talk to a lawyer before handling other people's money.

---

## What each file does

| File | In simple words |
|---|---|
| `SPEC.md` | The product plan. |
| `prisma/schema.prisma` | Database tables: waitlist, users, receipts, claim rules, claims, payouts, jobs, audit logs. |
| `prisma/migrations/` | The SQL that creates those tables. |
| `data/airports.csv` | ~7,900 airports with location and country, used to measure flight distance (open mwgg/Airports data). |
| **src/** | |
| `config.ts` | Reads `.env` and refuses unsafe or missing settings. |
| `bootstrap.ts` | Connects the real pieces: database, Firebase, Gemini, payments, worker. |
| `server.ts` | Starts the website (and the worker, by default). |
| `worker.ts` | Runs background jobs on their own (`npm run worker`). |
| `app.ts` | Security headers, rate limits, all routes and pages. |
| `lib/prisma.ts` | Database connection (always in UTC). |
| `lib/crypto.ts` | AES-256-GCM encryption and file fingerprints. |
| `lib/fileType.ts` | Checks what a file really is from its first bytes. |
| `lib/audit.ts` | Writes the "who did what" log. |
| `lib/money.ts` | Money maths in whole cents. |
| `auth/verifyToken.ts` | Checks Firebase logins; dev login for local testing. |
| `middleware/requireAuth.ts` | Blocks logged-out users; admin-only check with logging. |
| `jobs/queue.ts` | Background job queue in Postgres, with retries. |
| `jobs/handlers.ts` | The jobs: read a receipt, scan a user's receipts. |
| `services/receiptSchema.ts` | Exact fields we accept from the AI, with strict checks. |
| `services/receiptParser.ts` | Sends a receipt to Gemini and validates the answer. |
| `services/receiptProcessor.ts` | Save → queue → read → store result. |
| `services/storage.ts` | Encrypted file storage per user. |
| `services/retention.ts` | Deletes raw files and email text after 30 days. |
| `services/forwardingAddress.ts` | Each user's random private email address. |
| `services/letterWriter.ts` | Fills the claim template and has the AI polish it. |
| `services/claims.ts` | Claim statuses, flight answers, approval, fees, success rates. |
| `services/payments.ts` | Manual and Stripe fee collection. |
| `rules/engine.ts` | Runs every active rule on a user's receipts and saves new findings. |
| `rules/duplicate.ts` | Duplicate-charge rule. |
| `rules/subscription.ts` | Forgotten-subscription rule. |
| `rules/flight.ts` | EU261 / UK261 eligibility and amounts. |
| `rules/airports.ts` | Airport lookup, distance, EU/UK airlines. |
| `rules/defaultRules.ts` | The starting rules and their letter templates. |
| `rules/types.ts` | Shared shapes; store-name matching ("Amazon.co.uk" = "Amazon"). |
| `routes/waitlist.ts` | Landing-page signup. |
| `routes/me.ts` | My account: onboarding, new address, export, delete. |
| `routes/receipts.ts` | Upload and list receipts (own receipts only). |
| `routes/inboundEmail.ts` | Receives forwarded emails from Postmark. |
| `routes/claims.ts` | Money found and the claim tracker. |
| `routes/billing.ts` | Card setup, my fees, Stripe webhook. |
| `routes/admin.ts` | Admin dashboard data and actions. |
| **public/** | |
| `index.html`, `js/landing.js` | Landing page with waitlist. |
| `app.html`, `js/app.js` | Customer app: Money found, Receipts, Settings. |
| `admin.html`, `js/admin.js` | Admin dashboard. |
| `js/auth.js` | Shared login (Firebase or dev) and safe page helpers. |
| `terms.html`, `privacy.html` | Draft terms and privacy policy. |
| `css/styles.css` | Styling, dark mode, mobile. |
| **tests/** | 73 automatic tests (see above). |
| `Dockerfile`, `docker-compose.yml` | Run the app and database in containers (app runs as a non-root user). |

## Known limits (honest list)

- **Flight delays:** we can't see the actual delay from a booking email, so the user tells us what happened. A flight-status API (e.g. AeroDataBox) could confirm it automatically later. Airlines may refuse for "extraordinary circumstances" (weather, strikes); the letter asks them to prove it.
- **EU261 time limits** differ by country (1–10 years). We use 3 years to be safe; UK261 uses 6.
- **Subscriptions:** a refund of the last charge is a request, not a legal right in most cases. Track the success rate in admin and switch the rule off if it underperforms.
- **Duplicate "possible" findings** need the user's confirmation, because some people really do order twice.
- Claims are sent **manually** in this version, as the spec says.
