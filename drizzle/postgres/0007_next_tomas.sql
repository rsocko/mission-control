ALTER TABLE "tasks" ADD COLUMN "deleted_at" text;--> statement-breakpoint
CREATE INDEX "idx_tasks_deleted_at" ON "tasks" USING btree ("deleted_at");