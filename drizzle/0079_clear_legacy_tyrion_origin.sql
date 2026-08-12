UPDATE `connector_configs`
SET `settings` = '{}', `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'finance-manager-default'
	AND `type` IN ('finance-manager', 'monarch-money')
	AND `settings` = '{"bridgeUrl":"http://localhost:8100"}';
