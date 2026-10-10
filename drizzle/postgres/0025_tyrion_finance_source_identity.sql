UPDATE "tasks"
SET "source_list_id" = 'tyrion-finance',
    "source_list_name" = 'Tyrion'
WHERE "connector_type" = 'mission-control'
  AND "connector_instance_id" = 'mission-control'
  AND "source_id" LIKE 'finance-attention:%'
  AND jsonb_typeof("metadata"->'financeAttention') = 'object';
--> statement-breakpoint
UPDATE "task_search_documents" AS "search"
SET "source_list_name" = 'Tyrion'
FROM "tasks" AS "task"
WHERE "search"."id" = "task"."id"
  AND "task"."connector_type" = 'mission-control'
  AND "task"."connector_instance_id" = 'mission-control'
  AND "task"."source_id" LIKE 'finance-attention:%'
  AND jsonb_typeof("task"."metadata"->'financeAttention') = 'object';
