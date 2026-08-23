UPDATE `connector_configs`
SET `credentials` = json_set(
      COALESCE(`credentials`, '{}'),
      '$.identityNamespace',
      lower(hex(randomblob(32)))
    ),
    `settings` = json_remove(
      COALESCE(`settings`, '{}'),
      '$.cardRuleFingerprintParityProven',
      '$.cardRuleFingerprintParityProvenAt'
    ),
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
  AND json_type(COALESCE(`credentials`, '{}'), '$.identityNamespace') IS NULL;
--> statement-breakpoint
UPDATE `connector_configs`
SET `settings` = json_remove(
      COALESCE(`settings`, '{}'),
      '$.cardRuleFingerprintParityProven',
      '$.cardRuleFingerprintParityProvenAt'
    ),
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
  AND (
    json_type(COALESCE(`settings`, '{}'), '$.cardRuleFingerprintParityProven') IS NOT NULL
    OR json_type(COALESCE(`settings`, '{}'), '$.cardRuleFingerprintParityProvenAt') IS NOT NULL
  );
--> statement-breakpoint
DELETE FROM `finance_insight_publication_delivery`
WHERE `publication_id` IN (
  SELECT `id` FROM `finance_insight_publications`
  WHERE `connector_id` IN (
    SELECT `id` FROM `connector_configs`
    WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
  )
);
--> statement-breakpoint
UPDATE `finance_insight_cutovers`
SET `delivery_enabled` = 0,
    `rolled_back_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    `result` = '{"status":"rolled-back","reason":"identity-contract-upgraded"}',
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_insight_publication_facts`
WHERE `publication_id` IN (
  SELECT `id` FROM `finance_insight_publications`
  WHERE `connector_id` IN (
    SELECT `id` FROM `connector_configs`
    WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
  )
);
--> statement-breakpoint
DELETE FROM `finance_insight_publications`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
UPDATE `finance_insight_publication_state`
SET `latest_publication_id` = NULL,
    `last_capture_outcome` = NULL,
    `last_error_code` = NULL,
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_insight_transaction_projection_facts`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_insight_transaction_projection_windows`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_insight_transaction_projection_state`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_insight_transaction_window_proofs`
WHERE `plan_id` IN (
  SELECT `id` FROM `finance_insight_transaction_backfill_plans`
  WHERE `connector_id` IN (
    SELECT `id` FROM `connector_configs`
    WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
  )
);
--> statement-breakpoint
DELETE FROM `finance_insight_transaction_backfill_plans`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_dataset_sync_state`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_insight_occurrences`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_insight_occurrence_cache_state`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_attribution_exceptions`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
DELETE FROM `finance_attribution_subjects`
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
--> statement-breakpoint
UPDATE `finance_transactions`
SET `assigned_kid_id` = NULL,
    `kid_assignment_method` = NULL,
    `attribution_source_ref` = NULL,
    `attribution_contract_version` = NULL,
    `attribution_status` = 'pending',
    `attribution_confidence` = NULL,
    `attribution_method` = NULL,
    `attribution_explanation` = NULL,
    `attribution_reasons` = '[]',
    `attribution_decision_source` = NULL,
    `attribution_policy_version` = NULL,
    `attribution_engine_version` = NULL,
    `attribution_evaluated_at` = NULL,
    `attribution_review_state` = 'pending',
    `attribution_provenance` = NULL,
    `attribution_last_error_code` = NULL,
    `attribution_retryable` = 0,
    `attribution_updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `connector_instance_id` IN (
    SELECT `id` FROM `connector_configs`
    WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
  )
  AND `kid_assignment_method` IS NOT 'manual'
  AND `manual_decision_action` IS NULL
  AND `attribution_decision_source` IS NOT 'manual';
--> statement-breakpoint
UPDATE `finance_sync_state`
SET `attribution_status` = 'idle',
    `attribution_last_attempt_at` = NULL,
    `attribution_last_successful_at` = NULL,
    `attribution_last_error_code` = NULL,
    `attribution_policy_version` = NULL,
    `attribution_engine_version` = NULL,
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `connector_id` IN (
  SELECT `id` FROM `connector_configs`
  WHERE `type` IN ('finance-manager', 'finance', 'monarch-money')
);
