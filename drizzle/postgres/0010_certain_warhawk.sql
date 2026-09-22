ALTER TABLE "task_reminder_occurrences" ADD COLUMN "series_id" text;--> statement-breakpoint
ALTER TABLE "task_reminder_occurrences" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminder_nag_interval" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminder_nag_stop_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminder_nag_series_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminder_nag_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_task_reminder_occurrences_series_sequence" ON "task_reminder_occurrences" USING btree ("series_id","sequence") WHERE "task_reminder_occurrences"."series_id" IS NOT NULL;