CREATE TABLE "rymessage_action_v2_feed_state" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"feed_id" text,
	"cursor" text,
	"recovery_generation" integer DEFAULT 0 NOT NULL,
	"recovery_required" boolean DEFAULT true NOT NULL,
	"last_synced_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rymessage_action_v2_outbound_mutations" (
	"connector_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"action_id" text NOT NULL,
	"mutation" jsonb NOT NULL,
	"mutation_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_id" text,
	"lease_expires_at" text,
	"available_at" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"receipt" jsonb,
	"last_error_code" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "rymessage_action_v2_outbound_mutations_connector_id_operation_id_pk" PRIMARY KEY("connector_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "rymessage_action_v2_projections" (
	"connector_id" text NOT NULL,
	"action_id" text NOT NULL,
	"source_id" text NOT NULL,
	"revision" integer NOT NULL,
	"payload" jsonb,
	"payload_digest" text NOT NULL,
	"last_event_id" text NOT NULL,
	"last_operation_id" text NOT NULL,
	"tombstoned_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "rymessage_action_v2_projections_connector_id_action_id_pk" PRIMARY KEY("connector_id","action_id")
);
--> statement-breakpoint
CREATE TABLE "rymessage_action_v2_receipts" (
	"connector_id" text NOT NULL,
	"event_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"action_id" text NOT NULL,
	"aggregate_revision" integer NOT NULL,
	"payload_digest" text NOT NULL,
	"outcome" text NOT NULL,
	"received_at" text NOT NULL,
	CONSTRAINT "rymessage_action_v2_receipts_connector_id_event_id_pk" PRIMARY KEY("connector_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "rymessage_action_v2_feed_state" ADD CONSTRAINT "rymessage_action_v2_feed_state_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rymessage_action_v2_outbound_mutations" ADD CONSTRAINT "rymessage_action_v2_outbound_mutations_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rymessage_action_v2_projections" ADD CONSTRAINT "rymessage_action_v2_projections_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rymessage_action_v2_receipts" ADD CONSTRAINT "rymessage_action_v2_receipts_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_rymessage_action_v2_mutation_ready" ON "rymessage_action_v2_outbound_mutations" USING btree ("connector_id","status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rymessage_action_v2_source" ON "rymessage_action_v2_projections" USING btree ("connector_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_rymessage_action_v2_receipt_retention" ON "rymessage_action_v2_receipts" USING btree ("connector_id","received_at");