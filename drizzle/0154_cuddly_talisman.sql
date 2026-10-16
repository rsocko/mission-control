ALTER TABLE `task_projects` ADD `provenance` text DEFAULT 'local' NOT NULL;
--> statement-breakpoint
UPDATE task_projects
SET provenance = 'github-sync'
WHERE project_id IN (
  SELECT id
  FROM hub_projects
  WHERE id LIKE 'gh-project:%'
    OR json_extract(metadata, '$.syncManaged') = 1
    OR json_extract(json_extract(metadata, '$'), '$.syncManaged') = 1
);
--> statement-breakpoint
CREATE TEMP TABLE project_membership_recovery AS
WITH membership_events AS (
  SELECT
    commands.project_id,
    task_ids.value AS task_id,
    CASE commands.command_type
      WHEN 'assign_tasks' THEN 1
      ELSE 0
    END AS intent,
    commands.result_revision,
    commands.created_at,
    commands.id
  FROM project_hierarchy_commands AS commands
  JOIN json_each(json_extract(commands.request_json, '$.command.taskIds')) AS task_ids
  WHERE commands.actor_type = 'user'
    AND commands.command_type IN ('assign_tasks', 'remove_tasks')

  UNION ALL

  SELECT
    commands.project_id,
    json_extract(states.value, '$.taskId') AS task_id,
    CASE json_extract(states.value, '$.member')
      WHEN 1 THEN 1
      ELSE 0
    END AS intent,
    commands.result_revision,
    commands.created_at,
    commands.id
  FROM project_hierarchy_commands AS commands
  JOIN json_each(json_extract(commands.request_json, '$.command.states')) AS states
  WHERE commands.actor_type = 'user'
    AND commands.command_type = 'restore_project_tasks'
),
ranked_events AS (
  SELECT
    project_id,
    task_id,
    intent,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY project_id, task_id
      ORDER BY result_revision DESC, created_at DESC, id DESC
    ) AS event_rank
  FROM membership_events
  WHERE task_id IS NOT NULL
)
SELECT project_id, task_id, intent, created_at
FROM ranked_events
WHERE event_rank = 1;
--> statement-breakpoint
DELETE FROM task_projects
WHERE EXISTS (
  SELECT 1
  FROM project_membership_recovery AS recovery
  WHERE recovery.project_id = task_projects.project_id
    AND recovery.task_id = task_projects.task_id
    AND recovery.intent = 0
);
--> statement-breakpoint
INSERT INTO project_auto_include_exclusions (project_id, task_id, excluded_at)
SELECT recovery.project_id, recovery.task_id, recovery.created_at
FROM project_membership_recovery AS recovery
JOIN hub_projects ON hub_projects.id = recovery.project_id
JOIN tasks ON tasks.id = recovery.task_id
WHERE recovery.intent = 0
ON CONFLICT(project_id, task_id)
DO UPDATE SET excluded_at = excluded.excluded_at;
--> statement-breakpoint
DELETE FROM project_auto_include_exclusions
WHERE EXISTS (
  SELECT 1
  FROM project_membership_recovery AS recovery
  WHERE recovery.project_id = project_auto_include_exclusions.project_id
    AND recovery.task_id = project_auto_include_exclusions.task_id
    AND recovery.intent = 1
);
--> statement-breakpoint
INSERT INTO task_projects (task_id, project_id, provenance)
SELECT recovery.task_id, recovery.project_id, 'local'
FROM project_membership_recovery AS recovery
JOIN hub_projects ON hub_projects.id = recovery.project_id
JOIN tasks ON tasks.id = recovery.task_id
WHERE recovery.intent = 1
ON CONFLICT(task_id, project_id)
DO UPDATE SET provenance = 'local';
--> statement-breakpoint
DROP TABLE project_membership_recovery;