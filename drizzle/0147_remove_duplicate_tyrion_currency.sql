UPDATE `connector_configs`
SET `settings` = json_remove(COALESCE(`settings`, '{}'), '$.householdCurrency'),
	`updated_at` = CURRENT_TIMESTAMP
WHERE `type` IN ('finance-manager', 'monarch-money')
	AND json_type(COALESCE(`settings`, '{}'), '$.householdCurrency') IS NOT NULL;
