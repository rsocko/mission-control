UPDATE `tasks`
SET `source_list_id` = 'tyrion-finance',
    `source_list_name` = 'Tyrion'
WHERE `connector_type` = 'mission-control'
  AND `connector_instance_id` = 'mission-control'
  AND `source_id` LIKE 'finance-attention:%'
  AND json_type(`metadata`, '$.financeAttention') = 'object';
