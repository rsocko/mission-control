DELETE FROM `external_entity_bindings`
WHERE `binding_type` = 'task'
  AND NOT EXISTS (
    SELECT 1
    FROM `tasks`
    WHERE `tasks`.`id` = `external_entity_bindings`.`local_id`
      AND `tasks`.`connector_instance_id` = `external_entity_bindings`.`connector_instance_id`
  );