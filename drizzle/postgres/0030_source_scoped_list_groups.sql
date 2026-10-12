ALTER TABLE "list_groups" ADD COLUMN "connector_instance_id" text;--> statement-breakpoint
CREATE TEMP TABLE "_list_group_owners" AS
SELECT
  "group_id",
  "connector_instance_id",
  row_number() OVER (
    PARTITION BY "group_id"
    ORDER BY "connector_instance_id"
  ) AS "owner_rank"
FROM (
  SELECT DISTINCT "group_id", "connector_instance_id"
  FROM "source_lists"
  WHERE "group_id" IS NOT NULL
) AS "assigned_groups";--> statement-breakpoint
UPDATE "list_groups"
SET "connector_instance_id" = "_list_group_owners"."connector_instance_id"
FROM "_list_group_owners"
WHERE "_list_group_owners"."group_id" = "list_groups"."id"
  AND "_list_group_owners"."owner_rank" = 1;--> statement-breakpoint
INSERT INTO "list_groups" (
  "id",
  "connector_instance_id",
  "name",
  "icon",
  "icon_color",
  "source_id",
  "sort_order",
  "created_at"
)
SELECT
  "list_groups"."id" || '--source-' || "_list_group_owners"."connector_instance_id",
  "_list_group_owners"."connector_instance_id",
  "list_groups"."name",
  "list_groups"."icon",
  "list_groups"."icon_color",
  "list_groups"."source_id",
  "list_groups"."sort_order",
  "list_groups"."created_at"
FROM "_list_group_owners"
JOIN "list_groups" ON "list_groups"."id" = "_list_group_owners"."group_id"
WHERE "_list_group_owners"."owner_rank" > 1;--> statement-breakpoint
UPDATE "source_lists"
SET "group_id" = "source_lists"."group_id" || '--source-' || "source_lists"."connector_instance_id"
FROM "_list_group_owners"
WHERE "_list_group_owners"."group_id" = "source_lists"."group_id"
  AND "_list_group_owners"."connector_instance_id" = "source_lists"."connector_instance_id"
  AND "_list_group_owners"."owner_rank" > 1;--> statement-breakpoint
UPDATE "list_groups"
SET "connector_instance_id" = (
  SELECT "id"
  FROM "connector_configs"
  ORDER BY "created_at", "id"
  LIMIT 1
)
WHERE "connector_instance_id" IS NULL;--> statement-breakpoint
DROP TABLE "_list_group_owners";--> statement-breakpoint
CREATE INDEX "list_groups_connector_idx" ON "list_groups" USING btree ("connector_instance_id");