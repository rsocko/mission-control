CREATE TABLE "houston_conversation_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"authorization_scope" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commitments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sensitivity" text NOT NULL,
	"retain_until" text NOT NULL,
	"excluded_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_houston_memories_scope_updated" ON "houston_conversation_memories" USING btree ("authorization_scope","updated_at");--> statement-breakpoint
CREATE INDEX "idx_houston_memories_retention" ON "houston_conversation_memories" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "idx_houston_memories_excluded" ON "houston_conversation_memories" USING btree ("excluded_at");