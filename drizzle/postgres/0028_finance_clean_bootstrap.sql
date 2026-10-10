CREATE TABLE "finance_clean_bootstrap_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"mode" text NOT NULL,
	"actor_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"dry_run_id" text NOT NULL,
	"scope_digest" text NOT NULL,
	"confirmation_token" text NOT NULL,
	"inventory" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_clean_bootstrap_idempotency" ON "finance_clean_bootstrap_audit" USING btree ("connector_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_finance_clean_bootstrap_dry_run" ON "finance_clean_bootstrap_audit" USING btree ("connector_id","dry_run_id","mode");
