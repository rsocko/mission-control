ALTER TABLE "finance_transactions" ADD COLUMN "statement_descriptors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD COLUMN "location_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD COLUMN "location_evidence_input_fingerprint" text;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD COLUMN "location_inference_evidence" text;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD COLUMN "location_inference_error_code" text;