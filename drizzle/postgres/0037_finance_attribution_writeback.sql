ALTER TABLE finance_attribution_audit ADD COLUMN writeback_status text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE finance_attribution_audit ADD COLUMN writeback_request text;
--> statement-breakpoint
ALTER TABLE finance_attribution_audit ADD COLUMN writeback_error_code text;
--> statement-breakpoint
ALTER TABLE finance_attribution_audit ADD COLUMN writeback_updated_at text;
--> statement-breakpoint
CREATE INDEX idx_finance_attribution_writeback ON finance_attribution_audit(connector_id, writeback_status, created_at);
