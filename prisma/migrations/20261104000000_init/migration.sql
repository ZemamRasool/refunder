-- CreateEnum
CREATE TYPE "ReceiptSource" AS ENUM ('upload', 'email');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('pending', 'parsed', 'failed');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('duplicate_charge', 'forgotten_subscription', 'flight_compensation');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('found', 'approved', 'sent', 'won', 'lost', 'dismissed');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'processing', 'paid', 'failed', 'waived');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "waitlist_signups" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "country" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "firebase_uid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "country" TEXT,
    "forwarding_key" TEXT NOT NULL,
    "terms_version" TEXT,
    "terms_accepted_at" TIMESTAMP(3),
    "fee_percent" DECIMAL(5,2),
    "payment_customer_id" TEXT,
    "payment_method_ready" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" "ReceiptSource" NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'pending',
    "raw_file_url" TEXT,
    "mime_type" TEXT,
    "content_hash" TEXT,
    "raw_text" TEXT,
    "merchant" TEXT,
    "amount" DECIMAL(12,2),
    "currency" CHAR(3),
    "purchase_date" DATE,
    "order_id" TEXT,
    "parsed_json" JSONB,
    "parse_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_rules" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ClaimType" NOT NULL,
    "country" TEXT NOT NULL,
    "conditions_json" JSONB NOT NULL,
    "template_text" TEXT NOT NULL,
    "success_rate" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "claim_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "related_receipt_id" TEXT,
    "rule_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'found',
    "currency" CHAR(3),
    "expected_amount" DECIMAL(12,2),
    "recovered_amount" DECIMAL(12,2),
    "reason" TEXT NOT NULL,
    "details_json" JSONB NOT NULL,
    "letter_subject" TEXT,
    "letter_text" TEXT,
    "approved_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'pending',
    "currency" CHAR(3) NOT NULL,
    "fee_percent" DECIMAL(5,2) NOT NULL,
    "fee_amount" DECIMAL(12,2) NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT,
    "failure_reason" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "ip" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_signups_email_key" ON "waitlist_signups"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_forwarding_key_key" ON "users"("forwarding_key");

-- CreateIndex
CREATE INDEX "receipts_user_id_created_at_idx" ON "receipts"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "receipts_user_id_content_hash_idx" ON "receipts"("user_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "claim_rules_code_key" ON "claim_rules"("code");

-- CreateIndex
CREATE INDEX "claims_user_id_status_idx" ON "claims"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "claims_user_id_dedupe_key_key" ON "claims"("user_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_claim_id_key" ON "payouts"("claim_id");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- CreateIndex
CREATE INDEX "jobs_status_run_at_idx" ON "jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "claim_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
