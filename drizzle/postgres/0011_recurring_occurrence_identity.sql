CREATE TABLE IF NOT EXISTS "task_recurrence_occurrences" (
	"occurrence_id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"generated_from_task_id" text,
	"series_id" text NOT NULL,
	"rule_revision_id" text NOT NULL,
	"effective_kind" text NOT NULL,
	"effective_value" text NOT NULL,
	"local_date" text NOT NULL,
	"instant" text,
	"occurrence_number" integer,
	"anchor_kind" text NOT NULL,
	"anchor_value" text NOT NULL,
	"timezone_id" text NOT NULL,
	"timezone_kind" text NOT NULL,
	"materialization_strategy" text NOT NULL,
	"source_owner" text NOT NULL,
	"series_identity_kind" text NOT NULL,
	"stable_series_id" text,
	"connector_type" text,
	"connector_instance_id" text,
	"external_series_id" text,
	"series_stability" text,
	"created_at" text NOT NULL,
	CONSTRAINT "task_recurrence_occurrences_effective_check" CHECK ((
      ("task_recurrence_occurrences"."effective_kind" = 'local-date'
        AND "task_recurrence_occurrences"."effective_value" = "task_recurrence_occurrences"."local_date"
        AND "task_recurrence_occurrences"."instant" IS NULL)
      OR
      ("task_recurrence_occurrences"."effective_kind" = 'instant'
        AND "task_recurrence_occurrences"."effective_value" = "task_recurrence_occurrences"."instant"
        AND "task_recurrence_occurrences"."instant" IS NOT NULL)
    )),
	CONSTRAINT "task_recurrence_occurrences_anchor_check" CHECK ((
      ("task_recurrence_occurrences"."materialization_strategy" = 'on-schedule'
        AND "task_recurrence_occurrences"."anchor_kind" = 'schedule'
        AND "task_recurrence_occurrences"."generated_from_task_id" IS NULL)
      OR
      ("task_recurrence_occurrences"."materialization_strategy" = 'on-completion'
        AND "task_recurrence_occurrences"."anchor_kind" = 'completion'
        AND "task_recurrence_occurrences"."generated_from_task_id" IS NOT NULL)
    )),
	CONSTRAINT "task_recurrence_occurrences_provenance_check" CHECK ((
      ("task_recurrence_occurrences"."source_owner" = 'mission-control'
        AND "task_recurrence_occurrences"."series_identity_kind" = 'mission-control'
        AND "task_recurrence_occurrences"."stable_series_id" IS NOT NULL
        AND "task_recurrence_occurrences"."connector_type" IS NULL
        AND "task_recurrence_occurrences"."connector_instance_id" IS NULL
        AND "task_recurrence_occurrences"."external_series_id" IS NULL
        AND "task_recurrence_occurrences"."series_stability" IS NULL)
      OR
      ("task_recurrence_occurrences"."source_owner" = 'connector'
        AND "task_recurrence_occurrences"."connector_type" IS NOT NULL
        AND "task_recurrence_occurrences"."connector_instance_id" IS NOT NULL
        AND (
          ("task_recurrence_occurrences"."series_identity_kind" = 'mission-control'
            AND "task_recurrence_occurrences"."stable_series_id" IS NOT NULL
            AND "task_recurrence_occurrences"."external_series_id" IS NULL
            AND "task_recurrence_occurrences"."series_stability" IS NULL)
          OR
          ("task_recurrence_occurrences"."series_identity_kind" = 'connector'
            AND "task_recurrence_occurrences"."stable_series_id" IS NULL
            AND "task_recurrence_occurrences"."external_series_id" IS NOT NULL
            AND "task_recurrence_occurrences"."series_stability" IS NOT NULL)
        ))
    )),
	CONSTRAINT "task_recurrence_occurrences_number_check" CHECK ("task_recurrence_occurrences"."occurrence_number" IS NULL OR "task_recurrence_occurrences"."occurrence_number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_recurrence_occurrences_identity" ON "task_recurrence_occurrences" USING btree ("series_id","rule_revision_id","effective_kind","effective_value");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_recurrence_occurrences_task" ON "task_recurrence_occurrences" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_recurrence_occurrences_generation" ON "task_recurrence_occurrences" USING btree ("generated_from_task_id");--> statement-breakpoint
INSERT INTO "task_recurrence_occurrences" (
  "occurrence_id",
  "task_id",
  "generated_from_task_id",
  "series_id",
  "rule_revision_id",
  "effective_kind",
  "effective_value",
  "local_date",
  "instant",
  "occurrence_number",
  "anchor_kind",
  "anchor_value",
  "timezone_id",
  "timezone_kind",
  "materialization_strategy",
  "source_owner",
  "series_identity_kind",
  "stable_series_id",
  "connector_type",
  "connector_instance_id",
  "external_series_id",
  "series_stability",
  "created_at"
)
SELECT
  'occurrence:v1:{"effective":{"kind":'
    || to_json(CASE WHEN successor."due_date" LIKE '____-__-__T%' THEN 'instant' ELSE 'local-date' END)::text
    || ',"value":' || to_json(successor."due_date")::text
    || '},"revisionId":' || to_json(successor."metadata" -> 'canonicalRecurrence' -> 'revision' ->> 'id')::text
    || ',"seriesId":' || to_json(successor."metadata" -> 'canonicalRecurrence' -> 'series' ->> 'id')::text
    || ',"version":1}',
  successor."id",
  predecessor."id",
  successor."metadata" -> 'canonicalRecurrence' -> 'series' ->> 'id',
  successor."metadata" -> 'canonicalRecurrence' -> 'revision' ->> 'id',
  CASE WHEN successor."due_date" LIKE '____-__-__T%' THEN 'instant' ELSE 'local-date' END,
  successor."due_date",
  schedule."scheduled_date",
  CASE WHEN successor."due_date" LIKE '____-__-__T%' THEN successor."due_date" ELSE NULL END,
  NULL,
  'completion',
  predecessor."completed_at",
  successor."metadata" -> 'canonicalRecurrence' -> 'semantics' -> 'timezone' ->> 'id',
  successor."metadata" -> 'canonicalRecurrence' -> 'semantics' -> 'timezone' ->> 'kind',
  'on-completion',
  'mission-control',
  'mission-control',
  successor."metadata" -> 'canonicalRecurrence' -> 'series' -> 'identity' ->> 'stableId',
  NULL,
  NULL,
  NULL,
  NULL,
  successor."created_at"
FROM "tasks" AS successor
INNER JOIN "tasks" AS predecessor
  ON predecessor."id" = successor."recurrence_generated_from_task_id"
INNER JOIN "task_schedules" AS schedule
  ON schedule."task_id" = successor."id"
WHERE successor."recurrence_generated_from_task_id" IS NOT NULL
  AND successor."due_date" IS NOT NULL
  AND successor."due_date" ~ '^\d{4}-\d{2}-\d{2}(T.*Z)?$'
  AND (
    successor."due_date" LIKE '____-__-__T%'
    OR successor."due_date" = schedule."scheduled_date"
  )
  AND predecessor."completed_at" ~ 'T.*Z$'
  AND jsonb_typeof(successor."metadata" -> 'canonicalRecurrence' -> 'version') = 'number'
  AND successor."metadata" -> 'canonicalRecurrence' ->> 'version' = '1'
  AND successor."metadata" -> 'canonicalRecurrence' -> 'semantics' ->> 'mode' = 'completion'
  AND successor."metadata" -> 'canonicalRecurrence' -> 'semantics' -> 'materialization' ->> 'strategy' = 'on-completion'
  AND successor."metadata" -> 'canonicalRecurrence' -> 'source' ->> 'owner' = 'mission-control'
  AND successor."metadata" -> 'canonicalRecurrence' -> 'series' -> 'identity' ->> 'kind' = 'mission-control'
  AND successor."metadata" -> 'canonicalRecurrence' -> 'series' -> 'identity' ->> 'stableId' IS NOT NULL
  AND successor."metadata" -> 'canonicalRecurrence' -> 'series' ->> 'id' ~ '^series:v1:[0-9a-f]{64}$'
  AND successor."metadata" -> 'canonicalRecurrence' -> 'revision' ->> 'id' ~ '^revision:v1:[0-9a-f]{64}$'
  AND successor."metadata" -> 'canonicalRecurrence' -> 'semantics' -> 'timezone' ->> 'id' IS NOT NULL
  AND successor."metadata" -> 'canonicalRecurrence' -> 'semantics' -> 'timezone' ->> 'kind' IN ('iana', 'provider')
ON CONFLICT DO NOTHING;