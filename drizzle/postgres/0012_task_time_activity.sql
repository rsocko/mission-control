CREATE TABLE "task_time_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"active_key" integer,
	"target_seconds" integer NOT NULL,
	"elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"active_started_at" text,
	"started_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"last_command_id" text NOT NULL,
	"last_command_action" text NOT NULL,
	CONSTRAINT "task_time_activities_contract_check" CHECK ((
      "task_time_activities"."mode" IN ('focus', 'deadline')
      AND "task_time_activities"."state" IN ('running', 'paused', 'completed', 'cancelled')
      AND (("task_time_activities"."state" IN ('running', 'paused') AND "task_time_activities"."active_key" = 1)
        OR ("task_time_activities"."state" IN ('completed', 'cancelled') AND "task_time_activities"."active_key" IS NULL))
      AND "task_time_activities"."target_seconds" > 0
      AND "task_time_activities"."elapsed_seconds" >= 0
      AND "task_time_activities"."elapsed_seconds" <= "task_time_activities"."target_seconds"
    ))
);
--> statement-breakpoint
ALTER TABLE "task_time_activities" ADD CONSTRAINT "task_time_activities_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_time_activities_active" ON "task_time_activities" USING btree ("active_key");--> statement-breakpoint
CREATE INDEX "idx_task_time_activities_task_started" ON "task_time_activities" USING btree ("task_id","started_at");