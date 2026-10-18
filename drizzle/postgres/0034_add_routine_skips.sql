CREATE TABLE "routine_skips" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"date" text NOT NULL,
	"skipped_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_routine_skips_routine_date" ON "routine_skips" USING btree ("routine_id","date");
--> statement-breakpoint
CREATE INDEX "idx_routine_skips_date" ON "routine_skips" USING btree ("date");
