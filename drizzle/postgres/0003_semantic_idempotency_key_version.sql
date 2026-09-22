ALTER TABLE "semantic_intents" ADD COLUMN "idempotency_key_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "semantic_runs" ADD COLUMN "idempotency_key_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX "idx_semantic_intents_pending";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_intents_pending" ON "semantic_intents" USING btree ("idempotency_key_version","idempotency_key") WHERE "semantic_intents"."status" = 'queued';--> statement-breakpoint
DROP INDEX "idx_semantic_runs_idempotency";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_runs_idempotency" ON "semantic_runs" USING btree ("idempotency_key_version","idempotency_key");
