CREATE TABLE "finance_attention_delivery_receipts" (
	"delivery_key" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"payload_digest" text NOT NULL,
	"applied_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_finance_attention_delivery_connector" ON "finance_attention_delivery_receipts" USING btree ("connector_id","applied_at");
