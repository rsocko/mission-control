ALTER TABLE `finance_transactions` ADD `statement_descriptors` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `location_evidence` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `location_evidence_input_fingerprint` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `location_inference_evidence` text;--> statement-breakpoint
ALTER TABLE `finance_transactions` ADD `location_inference_error_code` text;