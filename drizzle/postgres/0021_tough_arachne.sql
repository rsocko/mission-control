DELETE FROM "semantic_documents"
WHERE "entity_type" = 'alert'
  AND "entity_id" IN (
    SELECT "id" FROM "notifications" WHERE "connector_type" = 'rymessage'
  );--> statement-breakpoint
DELETE FROM "notification_actions"
WHERE "notification_id" IN (
  SELECT "id" FROM "notifications" WHERE "connector_type" = 'rymessage'
);--> statement-breakpoint
DELETE FROM "notifications" WHERE "connector_type" = 'rymessage';--> statement-breakpoint
DELETE FROM "rymessage_action_v2_outbound_mutations";--> statement-breakpoint
DELETE FROM "rymessage_action_v2_receipts";--> statement-breakpoint
DELETE FROM "rymessage_action_v2_projections";--> statement-breakpoint
DELETE FROM "rymessage_action_v2_feed_state";--> statement-breakpoint
DROP TABLE "rymessage_action_feed_state" CASCADE;--> statement-breakpoint
DROP TABLE "rymessage_action_materializations" CASCADE;--> statement-breakpoint
DROP TABLE "rymessage_action_outbound_mutations" CASCADE;--> statement-breakpoint
DROP TABLE "rymessage_action_projections" CASCADE;--> statement-breakpoint
DROP TABLE "rymessage_action_receipts" CASCADE;