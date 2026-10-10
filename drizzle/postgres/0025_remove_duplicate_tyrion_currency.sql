UPDATE "connector_configs"
SET "settings" = COALESCE("settings", '{}'::jsonb) - 'householdCurrency',
	"updated_at" = CURRENT_TIMESTAMP
WHERE "type" IN ('finance-manager', 'monarch-money')
	AND COALESCE("settings", '{}'::jsonb) ? 'householdCurrency';
