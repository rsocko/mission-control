CREATE TABLE "my_day_suggestion_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"date" text NOT NULL,
	"excluded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_skips" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"date" text NOT NULL,
	"skipped_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_my_day_suggestion_exclusions_task_date" ON "my_day_suggestion_exclusions" USING btree ("task_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_routine_skips_routine_date" ON "routine_skips" USING btree ("routine_id","date");--> statement-breakpoint
CREATE INDEX "idx_routine_skips_date" ON "routine_skips" USING btree ("date");