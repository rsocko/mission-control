CREATE TABLE IF NOT EXISTS "task_recurrence_backfill_decisions" (
	"occurrence_id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"rule_revision_id" text NOT NULL,
	"effective_kind" text NOT NULL,
	"effective_value" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"task_id" text,
	"superseded_by_occurrence_id" text,
	"decided_at" text NOT NULL,
	CONSTRAINT "task_recurrence_backfill_decision_check" CHECK ("task_recurrence_backfill_decisions"."decision" IN (
        'materialized',
        'preserved',
        'collapsed',
        'superseded',
        'connector-owned-missing'
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_recurrence_backfill_identity" ON "task_recurrence_backfill_decisions" USING btree ("series_id","rule_revision_id","effective_kind","effective_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_recurrence_backfill_task" ON "task_recurrence_backfill_decisions" USING btree ("task_id");