CREATE TABLE "agent_dispatch_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"dispatch_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"priority" integer NOT NULL,
	"available_at" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_dispatch_actions" ADD CONSTRAINT "agent_dispatch_actions_dispatch_id_agent_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."agent_dispatches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_dispatch_actions_open" ON "agent_dispatch_actions" USING btree ("dispatch_id","action");
--> statement-breakpoint
CREATE INDEX "idx_agent_dispatch_actions_claim" ON "agent_dispatch_actions" USING btree ("status","available_at","priority","created_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_dispatch_actions_lease" ON "agent_dispatch_actions" USING btree ("status","lease_expires_at");
