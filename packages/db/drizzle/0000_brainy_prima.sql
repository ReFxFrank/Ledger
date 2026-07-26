CREATE TYPE "public"."actor" AS ENUM('user', 'system', 'provider', 'import');--> statement-breakpoint
CREATE TYPE "public"."attachment_purpose" AS ENUM('cancellation_confirmation', 'screenshot', 'correspondence', 'invoice', 'other');--> statement-breakpoint
CREATE TYPE "public"."billing_channel" AS ENUM('direct', 'apple', 'google', 'amazon', 'paypal', 'roku', 'carrier', 'microsoft', 'steam', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."cancellation_method" AS ENUM('account_settings', 'web_form', 'email', 'chat', 'phone', 'post', 'in_person', 'app_store');--> statement-breakpoint
CREATE TYPE "public"."cancellation_status" AS ENUM('draft', 'in_progress', 'awaiting_confirmation', 'confirmed', 'verified', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."category" AS ENUM('streaming_video', 'music_audio', 'gaming', 'software', 'ai', 'design', 'cloud_storage', 'security_vpn', 'news_publishing', 'fitness', 'food_delivery', 'dating', 'telecom', 'insurance', 'utilities', 'education', 'creator_support', 'storage_unit', 'pets', 'finance', 'health', 'transport', 'charity', 'other');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'reauth_required', 'consent_expiring', 'consent_expired', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."detection_status" AS ENUM('pending', 'confirmed', 'dismissed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."interval_unit" AS ENUM('day', 'week', 'month', 'year');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'push', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('trial_ending', 'renewal_upcoming', 'price_changed', 'cancel_by_deadline', 'cancellation_unconfirmed', 'charged_after_cancellation', 'new_detections', 'sync_failed', 'consent_expiring', 'duplicate_detected');--> statement-breakpoint
CREATE TYPE "public"."payment_method_type" AS ENUM('card', 'bank_account', 'paypal', 'wallet', 'other');--> statement-breakpoint
CREATE TYPE "public"."subscription_source" AS ENUM('manual', 'detected', 'csv_import', 'email_receipt');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'paused', 'cancel_scheduled', 'canceled', 'lapsed', 'unknown');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_i_d" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"last_reauth_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"display_currency" text DEFAULT 'USD' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellation_playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"channel" "billing_channel" DEFAULT 'direct' NOT NULL,
	"method" "cancellation_method" NOT NULL,
	"difficulty" smallint DEFAULT 2 NOT NULL,
	"cancel_url" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phone" text,
	"hours" text,
	"notice_period_days" integer DEFAULT 0 NOT NULL,
	"refund_policy" text,
	"retention_offer_notes" text,
	"gotchas" text[] DEFAULT '{}'::text[] NOT NULL,
	"letter_template" text,
	"evidence_hint" text,
	"source_url" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"category" "category" DEFAULT 'other' NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"descriptor_patterns" text[] DEFAULT '{}'::text[] NOT NULL,
	"logo_url" text,
	"typical_intervals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"superseded_by" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"interval_unit" interval_unit DEFAULT 'month' NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"region" text,
	"is_trial" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"official_name" text,
	"mask" text,
	"type" text DEFAULT 'depository' NOT NULL,
	"subtype" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"excluded_from_detection" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_item_id" text NOT NULL,
	"institution_id" text,
	"institution_name" text NOT NULL,
	"institution_logo" text,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"cursor" text,
	"consent_expires_at" timestamp with time zone,
	"access_token_ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"backfill_completed_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"type" "payment_method_type" DEFAULT 'card' NOT NULL,
	"brand" text,
	"last4" text,
	"exp_month" integer,
	"exp_year" integer,
	"bank_account_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"item_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscription_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"effective_from" date NOT NULL,
	"delta_bps" integer,
	"source" text DEFAULT 'detected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"person_label" text NOT NULL,
	"share_minor" integer NOT NULL,
	"is_self" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"merchant_id" uuid,
	"display_name" text NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"interval_unit" interval_unit DEFAULT 'month' NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"anchor_date" date NOT NULL,
	"next_renewal_at" timestamp with time zone,
	"last_charged_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"billing_channel" "billing_channel" DEFAULT 'unknown' NOT NULL,
	"payment_method_id" uuid,
	"category" "category" DEFAULT 'other' NOT NULL,
	"source" "subscription_source" DEFAULT 'manual' NOT NULL,
	"confidence" numeric(4, 3) DEFAULT '1.000' NOT NULL,
	"variable_amount" boolean DEFAULT false NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"cancel_by_at" timestamp with time zone,
	"notes" text,
	"url" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "transaction_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reversal_transaction_id" uuid NOT NULL,
	"original_transaction_id" uuid NOT NULL,
	"kind" text DEFAULT 'refund' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"raw_descriptor" text NOT NULL,
	"normalized_key" text NOT NULL,
	"merchant_id" uuid,
	"billing_channel" "billing_channel" DEFAULT 'direct' NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"subscription_id" uuid,
	"fx_rate" numeric(20, 10),
	"dedupe_hash" text NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"normalized_key" text NOT NULL,
	"merchant_id" uuid,
	"billing_channel" "billing_channel" DEFAULT 'direct' NOT NULL,
	"interval_unit" interval_unit NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"median_amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"amount_cv" numeric(6, 4) DEFAULT '0' NOT NULL,
	"occurrences" integer NOT NULL,
	"first_seen" date NOT NULL,
	"last_seen" date NOT NULL,
	"next_expected_at" date,
	"confidence" numeric(4, 3) NOT NULL,
	"status" "detection_status" DEFAULT 'pending' NOT NULL,
	"evidence" jsonb DEFAULT '{"transactionIds":[],"gapDays":[]}'::jsonb NOT NULL,
	"subscription_id" uuid,
	"dismissed_reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"request_id" uuid,
	"subscription_id" uuid,
	"s3_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"purpose" "attachment_purpose" DEFAULT 'other' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "actor" DEFAULT 'user' NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"method" "cancellation_method" NOT NULL,
	"channel" "billing_channel" DEFAULT 'direct' NOT NULL,
	"status" "cancellation_status" DEFAULT 'draft' NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deadline_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"expected_next_charge_at" timestamp with time zone,
	"verification_window_ends_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"charged_after_cancellation_tx_id" uuid,
	"confirmation_reference" text,
	"refund_expected_minor" integer,
	"refund_currency" text,
	"retention_offer" jsonb,
	"generated_letter" text,
	"outcome_notes" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_nudged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" "notification_type" NOT NULL,
	"channels" text[] DEFAULT '{email,in_app}'::text[] NOT NULL,
	"lead_time_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"quiet_hours_start_minute" integer DEFAULT 1320 NOT NULL,
	"quiet_hours_end_minute" integer DEFAULT 480 NOT NULL,
	"quiet_hours_enabled" text DEFAULT 'true' NOT NULL,
	"digest_day_of_week" smallint DEFAULT 0 NOT NULL,
	"digest_minute" integer DEFAULT 1080 NOT NULL,
	"renewal_alert_threshold_minor" integer DEFAULT 2000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" "notification_type" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"subscription_id" uuid,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"deferred_from" timestamp with time zone,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"actor" "actor" DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"ip" text,
	"ua" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"can_see_amounts" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_playbooks" ADD CONSTRAINT "cancellation_playbooks_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_superseded_by_merchants_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_catalog" ADD CONSTRAINT "plan_catalog_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_connection_id_bank_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_price_history" ADD CONSTRAINT "subscription_price_history_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_shares" ADD CONSTRAINT "subscription_shares_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_reversals" ADD CONSTRAINT "transaction_reversals_reversal_transaction_id_transactions_id_fk" FOREIGN KEY ("reversal_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_reversals" ADD CONSTRAINT "transaction_reversals_original_transaction_id_transactions_id_fk" FOREIGN KEY ("original_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_bank_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_request_id_cancellation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."cancellation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_events" ADD CONSTRAINT "cancellation_events_request_id_cancellation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."cancellation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_charged_after_cancellation_tx_id_transactions_id_fk" FOREIGN KEY ("charged_after_cancellation_tx_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "passkey_user_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credential_unique" ON "passkey" USING btree ("credential_i_d");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_merchant_channel_unique" ON "cancellation_playbooks" USING btree ("merchant_id","channel");--> statement-breakpoint
CREATE INDEX "playbook_verified_idx" ON "cancellation_playbooks" USING btree ("last_verified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_slug_unique" ON "merchants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "merchants_category_idx" ON "merchants" USING btree ("category");--> statement-breakpoint
CREATE INDEX "merchants_name_trgm_idx" ON "merchants" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "merchants_aliases_idx" ON "merchants" USING gin ("aliases");--> statement-breakpoint
CREATE INDEX "merchants_patterns_idx" ON "merchants" USING gin ("descriptor_patterns");--> statement-breakpoint
CREATE INDEX "plan_merchant_idx" ON "plan_catalog" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_connection_idx" ON "bank_accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_external_unique" ON "bank_accounts" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "bank_connections_user_idx" ON "bank_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_connections_item_unique" ON "bank_connections" USING btree ("provider","external_item_id");--> statement-breakpoint
CREATE INDEX "bank_connections_consent_idx" ON "bank_connections" USING btree ("consent_expires_at");--> statement-breakpoint
CREATE INDEX "payment_methods_user_idx" ON "payment_methods" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_unique" ON "webhook_deliveries" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_item_idx" ON "webhook_deliveries" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "price_history_subscription_idx" ON "subscription_price_history" USING btree ("subscription_id","effective_from");--> statement-breakpoint
CREATE INDEX "shares_subscription_idx" ON "subscription_shares" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_renewal_idx" ON "subscriptions" USING btree ("user_id","next_renewal_at");--> statement-breakpoint
CREATE INDEX "subscriptions_user_status_idx" ON "subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_merchant_idx" ON "subscriptions" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "subscriptions_trial_idx" ON "subscriptions" USING btree ("trial_ends_at");--> statement-breakpoint
CREATE INDEX "subscriptions_cancel_by_idx" ON "subscriptions" USING btree ("cancel_by_at");--> statement-breakpoint
CREATE INDEX "usage_subscription_idx" ON "usage_logs" USING btree ("subscription_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reversal_unique" ON "transaction_reversals" USING btree ("reversal_transaction_id");--> statement-breakpoint
CREATE INDEX "reversal_original_idx" ON "transaction_reversals" USING btree ("original_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_external_unique" ON "transactions" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_dedupe_unique" ON "transactions" USING btree ("account_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX "transactions_account_posted_idx" ON "transactions" USING btree ("account_id","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_normalized_idx" ON "transactions" USING btree ("normalized_key");--> statement-breakpoint
CREATE INDEX "transactions_subscription_idx" ON "transactions" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "transactions_merchant_idx" ON "transactions" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "detections_user_key_unique" ON "detections" USING btree ("user_id","normalized_key","currency");--> statement-breakpoint
CREATE INDEX "detections_user_status_idx" ON "detections" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "detections_confidence_idx" ON "detections" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "attachments_user_idx" ON "attachments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attachments_request_idx" ON "attachments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "cancellation_events_request_idx" ON "cancellation_events" USING btree ("request_id","at");--> statement-breakpoint
CREATE INDEX "cancellation_user_status_idx" ON "cancellation_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "cancellation_subscription_idx" ON "cancellation_requests" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "cancellation_deadline_idx" ON "cancellation_requests" USING btree ("deadline_at");--> statement-breakpoint
CREATE INDEX "cancellation_verification_idx" ON "cancellation_requests" USING btree ("verification_window_ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_prefs_unique" ON "notification_preferences" USING btree ("user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_unique" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_pending_idx" ON "notifications" USING btree ("scheduled_for") WHERE "notifications"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "push_endpoint_unique" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_user_at_idx" ON "audit_log" USING btree ("user_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "household_members_household_idx" ON "household_members" USING btree ("household_id");