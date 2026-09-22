UPDATE `tasks`
SET `planning_horizon` = CASE `planning_horizon`
  WHEN 'now' THEN 'next'
  WHEN 'next' THEN 'soon'
  ELSE `planning_horizon`
END
WHERE `planning_horizon` IN ('now', 'next');
--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_history_immutable_update`;
--> statement-breakpoint
UPDATE `task_history_events`
SET `previous_value` = CASE `previous_value`
  WHEN 'now' THEN 'next'
  WHEN 'next' THEN 'soon'
END
WHERE `field_name` = 'planningHorizon'
  AND `previous_value` IN ('now', 'next');
--> statement-breakpoint
UPDATE `task_history_events`
SET `new_value` = CASE `new_value`
  WHEN 'now' THEN 'next'
  WHEN 'next' THEN 'soon'
END
WHERE `field_name` = 'planningHorizon'
  AND `new_value` IN ('now', 'next');
--> statement-breakpoint
CREATE TRIGGER `task_history_immutable_update`
BEFORE UPDATE ON `task_history_events`
BEGIN
  SELECT RAISE(ABORT, 'task_history_events is append-only');
END;
--> statement-breakpoint
UPDATE `quick_sort_operations`
SET `before_snapshot` = json_set(
  `before_snapshot`,
  '$.planningHorizon',
  CASE json_extract(`before_snapshot`, '$.planningHorizon')
    WHEN 'now' THEN 'next'
    WHEN 'next' THEN 'soon'
  END
)
WHERE json_extract(`before_snapshot`, '$.planningHorizon') IN ('now', 'next');
--> statement-breakpoint
UPDATE `quick_sort_operations`
SET `before_snapshot` = json_set(
  `before_snapshot`,
  '$.originalPatch.planningHorizon',
  CASE json_extract(`before_snapshot`, '$.originalPatch.planningHorizon')
    WHEN 'now' THEN 'next'
    WHEN 'next' THEN 'soon'
  END
)
WHERE json_extract(`before_snapshot`, '$.originalPatch.planningHorizon') IN ('now', 'next');
--> statement-breakpoint
UPDATE `quick_sort_operations`
SET `after_snapshot` = json_set(
  `after_snapshot`,
  '$.planningHorizon',
  CASE json_extract(`after_snapshot`, '$.planningHorizon')
    WHEN 'now' THEN 'next'
    WHEN 'next' THEN 'soon'
  END
)
WHERE json_extract(`after_snapshot`, '$.planningHorizon') IN ('now', 'next');
