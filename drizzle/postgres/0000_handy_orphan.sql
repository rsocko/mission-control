CREATE TABLE "agent_dispatch_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"dispatch_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text NOT NULL,
	"provider_task_id" text,
	"provider_detail" jsonb,
	"error_message" text,
	"started_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "agent_dispatch_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"dispatch_id" text NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"detail" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"external_agent_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"instruction" text NOT NULL,
	"scope" jsonb NOT NULL,
	"status" text NOT NULL,
	"transport" text NOT NULL,
	"execution_locality" text NOT NULL,
	"data_classification" text NOT NULL,
	"allowed_actions" jsonb NOT NULL,
	"disclosed_fields" jsonb NOT NULL,
	"payload_preview" jsonb NOT NULL,
	"preview_hash" text NOT NULL,
	"provider_task_id" text,
	"provider_detail" jsonb,
	"result" jsonb,
	"result_digest" text,
	"result_status" text,
	"claim_token_hash" text,
	"claimed_at" text,
	"lease_expires_at" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" text NOT NULL,
	"deadline_at" text,
	"cancel_requested_at" text,
	"github_issue_url" text,
	"github_pull_request_url" text,
	"repository" text,
	"base_ref" text,
	"branch_ref" text,
	"commit_sha" text,
	"checks" jsonb,
	"artifacts" jsonb,
	"error_message" text,
	"confirmed_at" text,
	"started_at" text,
	"completed_at" text,
	"reviewed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_sessions" (
	"run_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"encrypted_reference" text NOT NULL,
	"initialization_vector" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" text NOT NULL,
	"state" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"feature_id" text NOT NULL,
	"sensitivity" text NOT NULL,
	"status" text NOT NULL,
	"execution_route" text NOT NULL,
	"requested_provider" text,
	"requested_model" text,
	"provider" text,
	"model" text,
	"fallback_state" text DEFAULT 'not_requested' NOT NULL,
	"correlation_id" text NOT NULL,
	"traceparent" text,
	"tracestate" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" text NOT NULL,
	"timeout_at" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" text,
	"cancel_requested_at" text,
	"started_at" text,
	"completed_at" text,
	"last_error_code" text,
	"last_error_message" text,
	"notify_on_completion" boolean DEFAULT false NOT NULL,
	"cleanup_status" text DEFAULT 'none' NOT NULL,
	"execution_state" jsonb,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alertmanager_integration_events" (
	"id" text PRIMARY KEY NOT NULL,
	"integration" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"authenticated" boolean DEFAULT false NOT NULL,
	"http_status" integer NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"applied" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"stale" integer DEFAULT 0 NOT NULL,
	"duplicate_receipts" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"occurred_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apns_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_hash" text NOT NULL,
	"environment" text NOT NULL,
	"topic" text NOT NULL,
	"app_version" text NOT NULL,
	"build_number" integer NOT NULL,
	"locale" text NOT NULL,
	"time_zone" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"invalidated_at" text,
	"invalidation_reason" text
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_mode" text DEFAULT 'poll' NOT NULL,
	"poll_interval_minutes" integer DEFAULT 5,
	"capabilities" jsonb NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_lists" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "connector_maintenance_locks" (
	"connector_instance_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"acquired_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_operation_leases" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"operation_type" text NOT NULL,
	"owner" text NOT NULL,
	"lease_expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_sync_controls" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"scheduler_state" text DEFAULT 'scheduled' NOT NULL,
	"quarantine_id" text,
	"quarantined_at" text,
	"released_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_sync_operator_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"quarantine_id" text,
	"operation" text NOT NULL,
	"actor_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"job_id" text,
	"result_code" text NOT NULL,
	"cancelled_queued_count" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "dependency_reconciliation_candidates" (
	"snapshot_id" text NOT NULL,
	"dependency_id" text NOT NULL,
	CONSTRAINT "dependency_reconciliation_candidates_snapshot_id_dependency_id_pk" PRIMARY KEY("snapshot_id","dependency_id")
);
--> statement-breakpoint
CREATE TABLE "dependency_reconciliation_edges" (
	"snapshot_id" text NOT NULL,
	"blocker_source_id" text NOT NULL,
	"blocked_source_id" text NOT NULL,
	"blocker_identity_evidence" jsonb,
	"blocker_identity_evidence_state" text DEFAULT 'missing' NOT NULL,
	CONSTRAINT "dependency_reconciliation_edges_snapshot_id_blocker_source_id_blocked_source_id_pk" PRIMARY KEY("snapshot_id","blocker_source_id","blocked_source_id")
);
--> statement-breakpoint
CREATE TABLE "dependency_reconciliation_items" (
	"snapshot_id" text NOT NULL,
	"position" integer NOT NULL,
	"source_id" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"identity_evidence" jsonb,
	"identity_evidence_state" text DEFAULT 'missing' NOT NULL,
	CONSTRAINT "dependency_reconciliation_items_snapshot_id_position_pk" PRIMARY KEY("snapshot_id","position")
);
--> statement-breakpoint
CREATE TABLE "dependency_reconciliation_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"status" text NOT NULL,
	"phase" text DEFAULT 'reconciling' NOT NULL,
	"read_mode" text,
	"cursor" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"batch_size" integer NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"removed_count" integer DEFAULT 0 NOT NULL,
	"started_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text,
	"collection_completed_at" text,
	"collection_page_count" integer DEFAULT 0 NOT NULL,
	"overflow_fetch_count" integer DEFAULT 0 NOT NULL,
	"identity_mode" text DEFAULT 'stable' NOT NULL,
	"identity_mode_revision" integer DEFAULT 0 NOT NULL,
	"identity_evidence_source" text DEFAULT 'legacy-unavailable' NOT NULL,
	"identity_evidence_eligible" boolean DEFAULT false NOT NULL,
	"identity_evidence_failure_reason" text,
	"failed_at" text,
	"next_attempt_at" text,
	"failure_reason" text,
	"last_resume_attempt_at" text,
	"last_resume_outcome" text,
	"last_resume_reason" text
);
--> statement-breakpoint
CREATE TABLE "energy_checkins" (
	"id" text PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"level" text NOT NULL,
	"note" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"transport" text NOT NULL,
	"execution_locality" text NOT NULL,
	"description" text,
	"endpoint" text,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"auth_credential_ref" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_format" text DEFAULT 'mc-tasks' NOT NULL,
	"output_format" text DEFAULT 'mc-tasks' NOT NULL,
	"inbound_webhook_id" text,
	"data_policy" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "external_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"host_key" text NOT NULL,
	"entity_type" text NOT NULL,
	"stable_id" text NOT NULL,
	"identity_version" integer DEFAULT 1 NOT NULL,
	"next_locator_revision" integer DEFAULT 1 NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	CONSTRAINT "external_entities_type_check" CHECK ("external_entities"."entity_type" IN ('repository', 'issue')),
	CONSTRAINT "external_entities_identity_version_check" CHECK ("external_entities"."identity_version" = 1),
	CONSTRAINT "external_entities_locator_revision_check" CHECK ("external_entities"."next_locator_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "external_entity_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"external_entity_id" text NOT NULL,
	"connector_instance_id" text NOT NULL,
	"binding_type" text NOT NULL,
	"local_id" text NOT NULL,
	"state" text DEFAULT 'shadow' NOT NULL,
	"verified_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "external_bindings_type_check" CHECK ("external_entity_bindings"."binding_type" IN ('task', 'source_list')),
	CONSTRAINT "external_bindings_state_check" CHECK ("external_entity_bindings"."state" IN ('shadow', 'active', 'collision', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "external_entity_locators" (
	"id" text PRIMARY KEY NOT NULL,
	"external_entity_id" text NOT NULL,
	"repository_entity_id" text,
	"provider" text NOT NULL,
	"host_key" text NOT NULL,
	"owner" text NOT NULL,
	"repository" text NOT NULL,
	"owner_key" text NOT NULL,
	"repository_key" text NOT NULL,
	"issue_number" integer,
	"api_url" text,
	"web_url" text,
	"valid_from" text NOT NULL,
	"valid_to" text,
	"last_seen_at" text NOT NULL,
	"observation_source" text NOT NULL,
	"locator_revision" integer NOT NULL,
	CONSTRAINT "external_locators_source_check" CHECK ("external_entity_locators"."observation_source" IN ('graphql', 'rest', 'backfill', 'operator')),
	CONSTRAINT "external_locators_revision_check" CHECK ("external_entity_locators"."locator_revision" >= 1),
	CONSTRAINT "external_locators_issue_repository_check" CHECK (("external_entity_locators"."issue_number" IS NULL AND "external_entity_locators"."repository_entity_id" IS NULL)
      OR ("external_entity_locators"."issue_number" IS NOT NULL AND "external_entity_locators"."repository_entity_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "finance_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"upstream_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"type" text NOT NULL,
	"institution" text,
	"mask" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_is_active" boolean DEFAULT true NOT NULL,
	"last_seen_generation_id" text DEFAULT '' NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"deactivated_at" text
);
--> statement-breakpoint
CREATE TABLE "finance_alert_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"kid_id" text,
	"period" text,
	"threshold_amount" double precision,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" text DEFAULT 'heads_up' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_attention_repair_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"mode" text NOT NULL,
	"actor_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"dry_run_id" text,
	"reason_code" text NOT NULL,
	"target_digest" text NOT NULL,
	"occurrence_count" integer NOT NULL,
	"notification_count" integer NOT NULL,
	"action_count" integer NOT NULL,
	"delivery_count" integer NOT NULL,
	"task_count" integer NOT NULL,
	"my_day_count" integer NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_attribution_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"exception_id" text,
	"idempotency_key" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"requested_kid_id" text,
	"requested_decision" text,
	"result_status" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_attribution_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"source_ref" text,
	"status" text DEFAULT 'open' NOT NULL,
	"reason_code" text NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"review_state" text DEFAULT 'pending' NOT NULL,
	"source_fingerprint" text NOT NULL,
	"policy_version" integer,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"resolution" text,
	"created_at" text NOT NULL,
	"first_observed_at" text NOT NULL,
	"last_observed_at" text NOT NULL,
	"resolved_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_attribution_subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"kid_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"engine_version" text NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_budget_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"upstream_category_id" text NOT NULL,
	"category_name" text NOT NULL,
	"budgeted" double precision NOT NULL,
	"spent" double precision NOT NULL,
	"remaining" double precision NOT NULL,
	"percent_used" double precision,
	"is_current" boolean DEFAULT true NOT NULL,
	"source_as_of" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"upstream_category_id" text NOT NULL,
	"name" text NOT NULL,
	"upstream_group_id" text,
	"group_name" text,
	"icon" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_is_active" boolean DEFAULT true NOT NULL,
	"last_seen_generation_id" text DEFAULT '' NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"deactivated_at" text
);
--> statement-breakpoint
CREATE TABLE "finance_category_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"upstream_group_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_is_active" boolean DEFAULT true NOT NULL,
	"last_seen_generation_id" text DEFAULT '' NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"deactivated_at" text
);
--> statement-breakpoint
CREATE TABLE "finance_connection_outages" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"status" text NOT NULL,
	"auth_state" text NOT NULL,
	"started_at" text NOT NULL,
	"last_observed_at" text NOT NULL,
	"notification_created_at" text,
	"task_created_at" text,
	"recovery_sync_succeeded_at" text,
	"recovered_at" text,
	"last_error_code" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_dataset_sync_state" (
	"connector_id" text NOT NULL,
	"dataset" text NOT NULL,
	"last_attempt_at" text,
	"last_attempt_outcome" text,
	"last_successful_at" text,
	"source_as_of" text,
	"fresh_until" text,
	"coverage_start" text,
	"coverage_end" text,
	"current_generation_id" text,
	"previous_generation_id" text,
	"schema_version" text DEFAULT '1.0' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"published_item_count" integer DEFAULT 0 NOT NULL,
	"insight_item_count" integer,
	"insight_content_digest" text,
	"insight_bridge_contract_version" text,
	"source_limit" integer NOT NULL,
	"last_error_code" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "finance_dataset_sync_state_connector_id_dataset_pk" PRIMARY KEY("connector_id","dataset")
);
--> statement-breakpoint
CREATE TABLE "finance_insight_cutover_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"operation" text NOT NULL,
	"actor_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_generation" text,
	"result_code" text NOT NULL,
	"blocker_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"legacy_expired_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"suppressed_delivery_count" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_insight_cutovers" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"cutover_at" text NOT NULL,
	"source_generation" text NOT NULL,
	"source_sequence" integer NOT NULL,
	"legacy_disabled" boolean DEFAULT false NOT NULL,
	"delivery_enabled" boolean DEFAULT false NOT NULL,
	"legacy_expired_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rolled_back_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_insight_occurrence_cache_state" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"source_generation" text NOT NULL,
	"source_sequence" integer DEFAULT 0 NOT NULL,
	"item_count" integer NOT NULL,
	"source_as_of" text NOT NULL,
	"refreshed_at" text NOT NULL,
	"summary_expires_at" text NOT NULL,
	"purge_after" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_insight_occurrences" (
	"connector_id" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"source_generation" text DEFAULT '' NOT NULL,
	"is_tombstone" boolean DEFAULT false NOT NULL,
	"insight_id" text NOT NULL,
	"delivery_revision" integer NOT NULL,
	"revision_digest" text DEFAULT '' NOT NULL,
	"source_sequence" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_source_ref" text NOT NULL,
	"entity_label" text NOT NULL,
	"analysis_state" text NOT NULL,
	"source_lifecycle" text,
	"severity" text NOT NULL,
	"confidence" text NOT NULL,
	"baseline_sufficiency" text NOT NULL,
	"headline" text NOT NULL,
	"freshness_state" text NOT NULL,
	"source_as_of" text,
	"target_descriptors" jsonb NOT NULL,
	"summary_payload" jsonb,
	"source_updated_at" text NOT NULL,
	"cached_at" text NOT NULL,
	CONSTRAINT "finance_insight_occurrences_connector_id_occurrence_id_pk" PRIMARY KEY("connector_id","occurrence_id")
);
--> statement-breakpoint
CREATE TABLE "finance_insight_publication_delivery" (
	"publication_id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"source_sequence" integer NOT NULL,
	"stage" text DEFAULT 'captured' NOT NULL,
	"next_batch_ordinal" integer DEFAULT 0 NOT NULL,
	"detector_set_version" text,
	"policy_version" integer,
	"evaluation_sequence" integer,
	"evaluation_state" text,
	"evaluation_idempotency_key" text,
	"last_attempt_at" text,
	"last_successful_at" text,
	"last_error_code" text,
	"last_error_retryable" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_insight_publication_facts" (
	"publication_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"batch_index" integer NOT NULL,
	"fact_index" integer NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "finance_insight_publication_facts_publication_id_kind_source_ref_pk" PRIMARY KEY("publication_id","kind","source_ref")
);
--> statement-breakpoint
CREATE TABLE "finance_insight_publication_state" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"provider_type" text NOT NULL,
	"latest_publication_id" text,
	"latest_generation_identity" text,
	"last_source_sequence" integer DEFAULT 0 NOT NULL,
	"last_capture_attempt_at" text,
	"last_capture_outcome" text,
	"last_error_code" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_insight_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"source_sequence" integer NOT NULL,
	"generation_identity" text NOT NULL,
	"contract_version" text NOT NULL,
	"provider_type" text NOT NULL,
	"source_as_of" text NOT NULL,
	"coverage_start" text NOT NULL,
	"coverage_end" text NOT NULL,
	"currency" text NOT NULL,
	"bridge_contract_version" text NOT NULL,
	"captured_constituents" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"create_request" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"alert_capable" boolean DEFAULT false NOT NULL,
	"captured_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_insight_transaction_backfill_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"horizon_months" integer NOT NULL,
	"coverage_start" text NOT NULL,
	"coverage_end" text NOT NULL,
	"currency" text NOT NULL,
	"bridge_contract_version" text NOT NULL,
	"window_count" integer NOT NULL,
	"next_window_ordinal" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"last_error_code" text,
	"completed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_insight_transaction_projection_facts" (
	"connector_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"source_ref" text NOT NULL,
	"occurred_on" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "finance_insight_transaction_projection_facts_connector_id_generation_id_source_ref_pk" PRIMARY KEY("connector_id","generation_id","source_ref")
);
--> statement-breakpoint
CREATE TABLE "finance_insight_transaction_projection_state" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"current_attempt_id" text,
	"last_attempt_at" text,
	"last_successful_at" text,
	"successful_generation_id" text,
	"source_as_of" text,
	"item_count" integer,
	"content_digest" text,
	"coverage_start" text,
	"coverage_end" text,
	"window_count" integer,
	"windows_digest" text,
	"bridge_contract_version" text,
	"last_error_code" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_insight_transaction_projection_windows" (
	"connector_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"window_index" integer NOT NULL,
	"coverage_start" text NOT NULL,
	"coverage_end" text NOT NULL,
	"source_as_of" text NOT NULL,
	"item_count" integer NOT NULL,
	"content_digest" text NOT NULL,
	CONSTRAINT "finance_insight_transaction_projection_windows_connector_id_generation_id_window_index_pk" PRIMARY KEY("connector_id","generation_id","window_index")
);
--> statement-breakpoint
CREATE TABLE "finance_insight_transaction_window_proofs" (
	"plan_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"window_ordinal" integer NOT NULL,
	"generation_ref" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"source_as_of" text NOT NULL,
	"item_count" integer NOT NULL,
	"content_digest" text NOT NULL,
	"currency" text NOT NULL,
	"bridge_contract_version" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "finance_insight_transaction_window_proofs_plan_id_window_ordinal_pk" PRIMARY KEY("plan_id","window_ordinal")
);
--> statement-breakpoint
CREATE TABLE "finance_mutation_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"connector_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"upstream_transaction_id" text NOT NULL,
	"operation" text NOT NULL,
	"requested_value" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "finance_recurring_obligations" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"upstream_recurring_id" text NOT NULL,
	"merchant" text NOT NULL,
	"amount" double precision NOT NULL,
	"frequency" text NOT NULL,
	"next_expected_date" text,
	"upstream_account_id" text,
	"account_name" text,
	"upstream_category_id" text,
	"category_name" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"source_as_of" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_sync_state" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"current_generation_id" text,
	"current_window_start" text,
	"current_window_end" text,
	"last_mode" text,
	"last_attempt_at" text,
	"last_successful_sync_at" text,
	"last_successful_generation_id" text,
	"last_successful_source_as_of" text,
	"last_successful_item_count" integer,
	"last_successful_content_digest" text,
	"last_successful_projection_start_date" text,
	"last_successful_projection_coverage_start" text,
	"last_successful_projection_coverage_end" text,
	"last_successful_bridge_contract_version" text,
	"last_successful_window_start" text,
	"last_successful_window_end" text,
	"last_error_code" text,
	"last_error_message" text,
	"last_added" integer DEFAULT 0 NOT NULL,
	"last_updated" integer DEFAULT 0 NOT NULL,
	"last_deleted" integer DEFAULT 0 NOT NULL,
	"attribution_status" text DEFAULT 'idle' NOT NULL,
	"attribution_last_attempt_at" text,
	"attribution_last_successful_at" text,
	"attribution_last_error_code" text,
	"attribution_policy_version" integer,
	"attribution_engine_version" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"upstream_tag_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_is_active" boolean DEFAULT true NOT NULL,
	"last_seen_generation_id" text DEFAULT '' NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"deactivated_at" text
);
--> statement-breakpoint
CREATE TABLE "finance_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text DEFAULT 'finance-manager-default' NOT NULL,
	"upstream_transaction_id" text NOT NULL,
	"date" text NOT NULL,
	"amount" double precision NOT NULL,
	"merchant_name" text,
	"merchant_logo_url" text,
	"category_id" text,
	"original_category" text,
	"confirmed_category" text,
	"account_id" text,
	"account_name" text,
	"card_last4" text,
	"assigned_kid_id" text,
	"kid_assignment_method" text,
	"manual_decision_action" text,
	"manual_decided_at" text,
	"attribution_source_ref" text,
	"attribution_contract_version" text,
	"attribution_status" text DEFAULT 'pending' NOT NULL,
	"attribution_confidence" text,
	"attribution_method" text,
	"attribution_explanation" text,
	"attribution_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attribution_decision_source" text,
	"attribution_policy_version" integer,
	"attribution_engine_version" text,
	"attribution_evaluated_at" text,
	"attribution_review_state" text DEFAULT 'pending' NOT NULL,
	"attribution_provenance" text,
	"attribution_last_error_code" text,
	"attribution_retryable" boolean DEFAULT false NOT NULL,
	"attribution_updated_at" text,
	"triage_status" text DEFAULT 'pending' NOT NULL,
	"flag_reason" text,
	"is_pending" boolean DEFAULT false NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tag_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"deleted_at" text,
	"provenance_provider" text,
	"provenance_fetched_at" text,
	"source_fingerprint" text DEFAULT '' NOT NULL,
	"source_url" text,
	"last_seen_generation_id" text,
	"first_seen_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"last_seen_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"synced_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_items" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"scope" text NOT NULL,
	"date" text NOT NULL,
	"slot" integer NOT NULL,
	"added_at" text NOT NULL,
	"is_ai_suggested" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_bulk_transfer_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_bulk_transfer_items" (
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"issue_entity_id" text NOT NULL,
	"issue_stable_id" text NOT NULL,
	"source_number" integer NOT NULL,
	"target_number" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"before_digest" text NOT NULL,
	"new_source_id" text,
	"last_error" text,
	"started_at" text,
	"completed_at" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "github_bulk_transfer_items_run_id_task_id_pk" PRIMARY KEY("run_id","task_id"),
	CONSTRAINT "github_bulk_transfer_items_state_check" CHECK ("github_bulk_transfer_items"."state" IN ('pending', 'transferring', 'transferred', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "github_bulk_transfer_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"phase" text NOT NULL,
	"actor" text NOT NULL,
	"source_repository" text NOT NULL,
	"target_repository" text NOT NULL,
	"plan_hash" text NOT NULL,
	"plan" jsonb NOT NULL,
	"connector_was_enabled" boolean NOT NULL,
	"transferred_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text,
	CONSTRAINT "github_bulk_transfer_runs_phase_check" CHECK ("github_bulk_transfer_runs"."phase" IN ('running', 'completed', 'failed', 'aborted'))
);
--> statement-breakpoint
CREATE TABLE "github_bulk_transfer_successions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"source_external_entity_id" text NOT NULL,
	"successor_external_entity_id" text NOT NULL,
	"source_stable_id_digest" text NOT NULL,
	"successor_stable_id_digest" text NOT NULL,
	"source_id" text NOT NULL,
	"successor_source_id" text NOT NULL,
	"target_repository_entity_id" text NOT NULL,
	"target_number" integer NOT NULL,
	"proof" jsonb NOT NULL,
	"proof_digest" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"observed_at" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "github_bulk_transfer_successions_distinct_entities_check" CHECK ("github_bulk_transfer_successions"."source_external_entity_id" <> "github_bulk_transfer_successions"."successor_external_entity_id"),
	CONSTRAINT "github_bulk_transfer_successions_digest_check" CHECK (length("github_bulk_transfer_successions"."source_stable_id_digest") = 64
        AND length("github_bulk_transfer_successions"."successor_stable_id_digest") = 64
        AND length("github_bulk_transfer_successions"."proof_digest") = 64),
	CONSTRAINT "github_bulk_transfer_successions_audit_check" CHECK ("github_bulk_transfer_successions"."target_number" > 0
        AND length("github_bulk_transfer_successions"."actor") BETWEEN 1 AND 80
        AND length("github_bulk_transfer_successions"."reason") BETWEEN 3 AND 500
        AND length("github_bulk_transfer_successions"."idempotency_key") BETWEEN 8 AND 192)
);
--> statement-breakpoint
CREATE TABLE "github_identity_backfill_items" (
	"connector_instance_id" text NOT NULL,
	"binding_type" text NOT NULL,
	"local_id" text NOT NULL,
	"state" text NOT NULL,
	"external_entity_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" text,
	"reason_code" text,
	"observed_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "github_identity_backfill_items_connector_instance_id_binding_type_local_id_pk" PRIMARY KEY("connector_instance_id","binding_type","local_id"),
	CONSTRAINT "github_backfill_items_type_check" CHECK ("github_identity_backfill_items"."binding_type" IN ('task', 'source_list')),
	CONSTRAINT "github_backfill_items_state_check" CHECK ("github_identity_backfill_items"."state" IN ('pending', 'bound', 'legacy_only', 'collision', 'inaccessible')),
	CONSTRAINT "github_backfill_items_attempt_check" CHECK ("github_identity_backfill_items"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "github_identity_collisions" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"category" text NOT NULL,
	"fingerprint" text NOT NULL,
	"binding_type" text NOT NULL,
	"local_ids" jsonb NOT NULL,
	"external_entity_ids" jsonb NOT NULL,
	"legacy_identity_digest" text,
	"state" text DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"resolved_at" text,
	"resolved_by" text,
	CONSTRAINT "github_identity_collisions_category_check" CHECK ("github_identity_collisions"."category" IN ('multiple_local_one_stable', 'one_local_multiple_stable', 'stable_legacy_disagree', 'repository_path_replacement', 'same_stable_id_different_hosts', 'locator_overlap_or_regression')),
	CONSTRAINT "github_identity_collisions_type_check" CHECK ("github_identity_collisions"."binding_type" IN ('task', 'source_list')),
	CONSTRAINT "github_identity_collisions_state_check" CHECK ("github_identity_collisions"."state" IN ('open', 'resolved', 'accepted_legacy_only'))
);
--> statement-breakpoint
CREATE TABLE "github_identity_controls" (
	"connector_instance_id" text PRIMARY KEY NOT NULL,
	"mode_revision" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "github_identity_controls_revision_check" CHECK ("github_identity_controls"."mode_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "github_identity_exception_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"binding_type" text NOT NULL,
	"local_id" text NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"proof_type" text,
	"created_at" text NOT NULL,
	CONSTRAINT "github_identity_exception_events_type_check" CHECK ("github_identity_exception_events"."binding_type" IN ('task', 'source_list')),
	CONSTRAINT "github_identity_exception_events_category_check" CHECK ("github_identity_exception_events"."category" IN ('terminal_inaccessible')),
	CONSTRAINT "github_identity_exception_events_action_check" CHECK ("github_identity_exception_events"."action" IN ('accept', 'revoke')),
	CONSTRAINT "github_identity_exception_events_proof_check" CHECK ("github_identity_exception_events"."proof_type" IS NULL OR "github_identity_exception_events"."proof_type" IN ('stage1_inaccessible', 'post_backfill_authoritative_deletion', 'legacy_comparison_evidence')),
	CONSTRAINT "github_identity_exception_events_proof_state_check" CHECK (("github_identity_exception_events"."action" = 'revoke' AND "github_identity_exception_events"."proof_type" IS NULL)
      OR ("github_identity_exception_events"."action" = 'accept' AND "github_identity_exception_events"."proof_type" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "github_identity_migrations" (
	"connector_instance_id" text PRIMARY KEY NOT NULL,
	"phase" text DEFAULT 'disabled' NOT NULL,
	"task_cursor" text,
	"source_list_cursor" text,
	"batch_size" integer DEFAULT 100 NOT NULL,
	"started_at" text,
	"updated_at" text NOT NULL,
	"completed_at" text,
	"last_error" text,
	"counters" jsonb DEFAULT '{"eligible":0,"bound":0,"legacyOnly":0,"inaccessible":0,"pending":0,"collisions":0,"batches":0,"retries":0,"rateLimitPauses":0}'::jsonb NOT NULL,
	CONSTRAINT "github_identity_migrations_phase_check" CHECK ("github_identity_migrations"."phase" IN ('disabled', 'schema_ready', 'shadow_write', 'backfilling', 'paused', 'complete')),
	CONSTRAINT "github_identity_migrations_batch_size_check" CHECK ("github_identity_migrations"."batch_size" BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "github_identity_mode_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"old_phase" text NOT NULL,
	"new_phase" text NOT NULL,
	"old_effective_mode" text NOT NULL,
	"new_effective_mode" text NOT NULL,
	"old_stable_primary_enabled" boolean NOT NULL,
	"new_stable_primary_enabled" boolean NOT NULL,
	"old_mode_revision" integer NOT NULL,
	"new_mode_revision" integer NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"gate_result_code" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_identity_task_transfer_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"source_task_id" text NOT NULL,
	"successor_task_id" text NOT NULL,
	"source_external_entity_id" text NOT NULL,
	"successor_external_entity_id" text NOT NULL,
	"expected_mode_revision" integer NOT NULL,
	"proof_kind" text NOT NULL,
	"proof" jsonb NOT NULL,
	"proof_digest" text NOT NULL,
	"observed_at" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "github_task_transfer_reconciliations_distinct_tasks_check" CHECK ("github_identity_task_transfer_reconciliations"."source_task_id" <> "github_identity_task_transfer_reconciliations"."successor_task_id"),
	CONSTRAINT "github_task_transfer_reconciliations_distinct_entities_check" CHECK ("github_identity_task_transfer_reconciliations"."source_external_entity_id" <> "github_identity_task_transfer_reconciliations"."successor_external_entity_id"),
	CONSTRAINT "github_task_transfer_reconciliations_revision_check" CHECK ("github_identity_task_transfer_reconciliations"."expected_mode_revision" >= 0),
	CONSTRAINT "github_task_transfer_reconciliations_proof_check" CHECK ("github_identity_task_transfer_reconciliations"."proof_kind" = 'rest_historical_redirect'
        AND length("github_identity_task_transfer_reconciliations"."proof_digest") = 64),
	CONSTRAINT "github_task_transfer_reconciliations_audit_check" CHECK (length("github_identity_task_transfer_reconciliations"."actor") BETWEEN 1 AND 80
        AND length("github_identity_task_transfer_reconciliations"."reason") BETWEEN 3 AND 500
        AND length("github_identity_task_transfer_reconciliations"."idempotency_key") BETWEEN 8 AND 192)
);
--> statement-breakpoint
CREATE TABLE "github_identity_write_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"job_id" text,
	"mode_revision" integer NOT NULL,
	"pending_candidate_count" integer DEFAULT 0 NOT NULL,
	"observed_route_count" integer DEFAULT 0 NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"unknown_count" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"reconciliation_state" text DEFAULT 'unresolved' NOT NULL,
	"reconciliation_reason" text,
	"reconciliation_code" text,
	"reconciled_at" text,
	"reconciled_by" text,
	"reconciliation_idempotency_key" text,
	"started_at" text NOT NULL,
	"completed_at" text,
	CONSTRAINT "github_identity_write_cycles_state_check" CHECK ("github_identity_write_cycles"."state" IN ('running', 'completed', 'interrupted')),
	CONSTRAINT "github_identity_write_cycles_count_check" CHECK ("github_identity_write_cycles"."pending_candidate_count" >= 0 AND "github_identity_write_cycles"."observed_route_count" >= 0
      AND "github_identity_write_cycles"."applied_count" >= 0 AND "github_identity_write_cycles"."blocked_count" >= 0
      AND "github_identity_write_cycles"."failed_count" >= 0 AND "github_identity_write_cycles"."unknown_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "github_repository_repoint_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"phase" text NOT NULL,
	"actor" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_repository_repoints" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"phase" text NOT NULL,
	"actor" text NOT NULL,
	"host_key" text NOT NULL,
	"repository_entity_id" text NOT NULL,
	"repository_stable_id" text NOT NULL,
	"from_owner" text NOT NULL,
	"from_repository" text NOT NULL,
	"to_owner" text NOT NULL,
	"to_repository" text NOT NULL,
	"connector_was_enabled" boolean NOT NULL,
	"backup_proof" jsonb NOT NULL,
	"preflight" jsonb NOT NULL,
	"rollback_snapshot" jsonb NOT NULL,
	"verification" jsonb,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text,
	CONSTRAINT "github_repository_repoints_phase_check" CHECK ("github_repository_repoints"."phase" IN ('locked', 'applying', 'applied', 'verifying', 'verified', 'verification_failed', 'rolling_back', 'rolled_back', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "github_write_outcome_events" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"cycle_id" text NOT NULL,
	"lease_id" text NOT NULL,
	"task_id" text NOT NULL,
	"operation" text NOT NULL,
	"task_version" text NOT NULL,
	"expected_mode_revision" integer NOT NULL,
	"outcome" text NOT NULL,
	"proof_kind" text NOT NULL,
	"proof_digest" text NOT NULL,
	"remote_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "github_write_outcome_events_outcome_check" CHECK ("github_write_outcome_events"."outcome" IN ('proven_applied', 'proven_not_applied_retryable')),
	CONSTRAINT "github_write_outcome_events_proof_check" CHECK (("github_write_outcome_events"."proof_kind" = 'issue_state'
        AND "github_write_outcome_events"."remote_state" IN ('open', 'closed', 'authoritative_absent'))
      OR ("github_write_outcome_events"."proof_kind" = 'local_finalization'
        AND "github_write_outcome_events"."remote_state" IN ('locally_succeeded', 'locally_failed_pre_dispatch'))),
	CONSTRAINT "github_write_outcome_events_audit_check" CHECK (length("github_write_outcome_events"."actor") BETWEEN 1 AND 80
      AND length("github_write_outcome_events"."reason") BETWEEN 3 AND 500
      AND length("github_write_outcome_events"."idempotency_key") BETWEEN 8 AND 192
      AND length("github_write_outcome_events"."proof_digest") = 64)
);
--> statement-breakpoint
CREATE TABLE "graph_workspace_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"content_revision" integer NOT NULL,
	"current_document" jsonb NOT NULL,
	"archived_at" text,
	"migration_source" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "homelab_alert_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"integration" text NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" text NOT NULL,
	"notification_id" text NOT NULL,
	"first_received_at" text NOT NULL,
	"last_received_at" text NOT NULL,
	"delivery_count" integer DEFAULT 1 NOT NULL,
	"applied" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "houston_conversation_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"authorization_scope" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commitments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sensitivity" text NOT NULL,
	"retain_until" text NOT NULL,
	"excluded_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "houston_finance_action_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"call_hash" text NOT NULL,
	"tool" text NOT NULL,
	"decision" text NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "houston_finance_pending_approvals" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool" text NOT NULL,
	"tool_input" text NOT NULL,
	"correlation_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"icon" text,
	"icon_color" text,
	"source_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_include_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kanban_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_view" text DEFAULT 'list' NOT NULL,
	"default_filters" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"status_override" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"category" text,
	"target_date" text,
	"started_at" text,
	"completed_at" text,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"hierarchy_revision" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_webhook_log" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer NOT NULL,
	"created_type" text,
	"created_id" text,
	"error_message" text,
	"payload_preview" text,
	"received_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_webhook_replays" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"delivery_key" text NOT NULL,
	"received_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source_label" text DEFAULT 'webhook' NOT NULL,
	"secret" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"default_action" text DEFAULT 'auto' NOT NULL,
	"field_mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_received" integer DEFAULT 0 NOT NULL,
	"last_received_at" text,
	"last_status" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"api_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kid_card_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"kid_id" text NOT NULL,
	"card_last4" text NOT NULL,
	"account_id" text,
	"confidence" double precision DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kid_merchant_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"kid_id" text NOT NULL,
	"merchant_pattern" text NOT NULL,
	"confidence" double precision DEFAULT 0.8 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kid_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"avatar" text,
	"daily_limit" double precision,
	"weekly_limit" double precision,
	"monthly_limit" double precision
);
--> statement-breakpoint
CREATE TABLE "list_fix_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL,
	"strategy" text NOT NULL,
	"status" text NOT NULL,
	"original_list_id" text NOT NULL,
	"original_source_id" text NOT NULL,
	"original_name" text NOT NULL,
	"original_group_id" text,
	"connector_instance_id" text NOT NULL,
	"new_list_id" text,
	"new_name" text NOT NULL,
	"task_snapshot" jsonb,
	"move_results" jsonb,
	"tasks_total" integer DEFAULT 0 NOT NULL,
	"tasks_moved" integer DEFAULT 0 NOT NULL,
	"tasks_failed" integer DEFAULT 0 NOT NULL,
	"old_list_deleted" boolean DEFAULT false NOT NULL,
	"undone_at" text,
	"undo_notes" text
);
--> statement-breakpoint
CREATE TABLE "list_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"icon_color" text,
	"source_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_type" text NOT NULL,
	"status" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"checkpoint_start" text,
	"checkpoint_end" text,
	"scanned_count" integer DEFAULT 0 NOT NULL,
	"mutation_count" integer DEFAULT 0 NOT NULL,
	"has_more" boolean DEFAULT false NOT NULL,
	"lease_expires_at" text NOT NULL,
	"error_message" text,
	"started_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "my_day_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"date" text NOT NULL,
	"removed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "my_day_items" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"date" text NOT NULL,
	"added_at" text NOT NULL,
	"is_auto_included" boolean DEFAULT false NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_installation_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"issued_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	CONSTRAINT "native_installation_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "native_push_requests" (
	"credential_id" text NOT NULL,
	"request_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "native_push_requests_credential_id_request_id_pk" PRIMARY KEY("credential_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "native_share_capture_requests" (
	"credential_id" text NOT NULL,
	"request_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"reservation_id" text NOT NULL,
	"item_id" text,
	"created_at" text NOT NULL,
	"completed_at" text,
	CONSTRAINT "native_share_capture_requests_credential_id_request_id_pk" PRIMARY KEY("credential_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "native_share_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text NOT NULL,
	"issued_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	CONSTRAINT "native_share_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "notification_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"action_type" text NOT NULL,
	"label" text NOT NULL,
	"icon" text,
	"variant" text DEFAULT 'secondary' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opens_external" boolean DEFAULT false NOT NULL,
	"requires_confirmation" boolean DEFAULT false NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"execution_state" text DEFAULT 'pending' NOT NULL,
	"claimed_at" text,
	"completed_at" text,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"channel" text DEFAULT 'web_push' NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"suppression_reason" text,
	"policy_snapshot" jsonb NOT NULL,
	"payload_snapshot" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" text,
	"lease_expires_at" text,
	"claim_token" text,
	"subscriptions_attempted" integer DEFAULT 0 NOT NULL,
	"subscriptions_sent" integer DEFAULT 0 NOT NULL,
	"subscriptions_failed" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"sent_at" text,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "notification_push_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"template_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"min_level" text NOT NULL,
	"preview" text NOT NULL,
	"max_per_hour" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_saved_views" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_search_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"category" text,
	"connector_type" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B') || setweight(to_tsvector('english', coalesce(category, '') || ' ' || coalesce(connector_type, '')), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "notification_writeback_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"connector_instance_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"source_id" text NOT NULL,
	"action_type" text DEFAULT 'mark_done' NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retryable" boolean DEFAULT true NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" text NOT NULL,
	"lease_expires_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"completed_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"connector_instance_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')) STORED,
	"level" text DEFAULT 'fyi' NOT NULL,
	"level_rank" integer DEFAULT 3 NOT NULL,
	"category" text DEFAULT 'system' NOT NULL,
	"template_key" text,
	"state" text DEFAULT 'unread' NOT NULL,
	"read_state" text DEFAULT 'unread' NOT NULL,
	"disposition" text DEFAULT 'inbox' NOT NULL,
	"source_state" text DEFAULT 'active' NOT NULL,
	"sync_state" text DEFAULT 'synced' NOT NULL,
	"read_at" text,
	"handled_at" text,
	"dismissed_at" text,
	"resolved_at" text,
	"archived_at" text,
	"muted_at" text,
	"snoozed_until" text,
	"source_resolved_at" text,
	"last_source_activity_at" text,
	"last_source_activity_key" text,
	"handled_source_activity_at" text,
	"handled_source_activity_key" text,
	"last_source_synced_at" text,
	"is_actionable" boolean DEFAULT false NOT NULL,
	"primary_action_id" text,
	"ai_suggested_action_id" text,
	"received_at" text NOT NULL,
	"sort_at" text NOT NULL,
	"expires_at" text,
	"group_key" text,
	"dedupe_key" text,
	"related_task_id" text,
	"related_project_id" text,
	"related_entity_type" text,
	"related_entity_id" text,
	"navigation_target" text,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"last_reconciled_at" text,
	"stale_since" text,
	"auto_resolve_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"presentation" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret" text,
	"event_types" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_triggered_at" text,
	"last_status" integer,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "priority_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"reference_id" text,
	"description" text,
	"tier" text DEFAULT 'standard' NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"active_task_count" integer DEFAULT 0 NOT NULL,
	"last_touched_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "priority_sync_log" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"connector_instance_id" text NOT NULL,
	"previous_priority" text NOT NULL,
	"new_priority" text NOT NULL,
	"direction" text NOT NULL,
	"write_back_triggered" boolean DEFAULT false NOT NULL,
	"note" text,
	"timestamp" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_auto_include_exclusions" (
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"excluded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_hierarchy_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"base_revision" integer NOT NULL,
	"result_revision" integer NOT NULL,
	"command_type" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"inverse_command_json" jsonb,
	"result_json" jsonb NOT NULL,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"actor_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_hierarchy_mutation_context" (
	"project_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"target_date" text,
	"completed_at" text,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_phase_items" (
	"id" text PRIMARY KEY NOT NULL,
	"phase_id" text NOT NULL,
	"task_id" text NOT NULL,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"estimated_effort_hours" double precision,
	"is_proposed" boolean DEFAULT false NOT NULL,
	"proposal_type" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_phases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"color" text,
	"estimated_days" double precision,
	"target_start" text,
	"target_end" text,
	"start_after_phase_id" text,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"completed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_tags" (
	"project_id" text NOT NULL,
	"tag_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_preferences" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"morning_enabled" boolean DEFAULT true NOT NULL,
	"morning_hour" integer DEFAULT 8 NOT NULL,
	"triage_nudge_enabled" boolean DEFAULT true NOT NULL,
	"triage_nudge_threshold" integer DEFAULT 5 NOT NULL,
	"carry_forward_enabled" boolean DEFAULT true NOT NULL,
	"carry_forward_hour" integer DEFAULT 18 NOT NULL,
	"quiet_start" integer,
	"quiet_end" integer,
	"do_not_disturb" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text DEFAULT 'web' NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb NOT NULL,
	"user_agent" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_triage_log" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"operation_id" text,
	"mode" text NOT NULL,
	"action" text NOT NULL,
	"triaged_at" text NOT NULL,
	"reversed_at" text
);
--> statement-breakpoint
CREATE TABLE "quick_sort_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"mode" text NOT NULL,
	"action" text NOT NULL,
	"label" text NOT NULL,
	"context_key" text NOT NULL,
	"queue_index" integer NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"state" text NOT NULL,
	"ai_accepted" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"undone_at" text
);
--> statement-breakpoint
CREATE TABLE "resets" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"went_well" text,
	"needs_adjustment" text,
	"notes" text,
	"stats" jsonb,
	"ai_summary" text,
	"stale_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"carry_forward_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_win" text,
	"monthly_change" text,
	"intentions" jsonb,
	"completed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_completions" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"date" text NOT NULL,
	"notes" text,
	"completed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cadence_type" text NOT NULL,
	"cadence_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"icon" text,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_telemetry" (
	"role" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" text NOT NULL,
	"heartbeat_at" text NOT NULL,
	"metrics" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_telemetry_instances" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"pid" integer NOT NULL,
	"started_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"stopped_at" text,
	"terminal_reason" text,
	"restart_count" integer,
	"build_sha" text,
	"runtime_mode" text NOT NULL,
	"high_water_metrics" jsonb NOT NULL,
	"terminal_metrics" jsonb
);
--> statement-breakpoint
CREATE TABLE "runtime_telemetry_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"instance_id" text NOT NULL,
	"pid" integer NOT NULL,
	"sampled_at" text NOT NULL,
	"resolution_seconds" integer DEFAULT 10 NOT NULL,
	"metrics" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scout_reconciliation_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"candidate_action" text NOT NULL,
	"action" text NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"policy_decision" text NOT NULL,
	"policy_reason" text NOT NULL,
	"payload_hash" text NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"applied_result" jsonb,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scout_reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"lookback_hours" integer NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"source_identity" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"lease_token" text NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb,
	"error" text,
	"started_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "scout_reconciliation_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"evaluation_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"policy_decision" text NOT NULL,
	"policy_reason" text NOT NULL,
	"payload_hash" text NOT NULL,
	"proposed_effect" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"acted_at" text,
	"acted_by" text
);
--> statement-breakpoint
CREATE TABLE "scout_reconciliation_task_state" (
	"task_id" text PRIMARY KEY NOT NULL,
	"never_auto_complete" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"source_run_id" text,
	"updated_at" text NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semantic_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"index_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_revision" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"projection_version" integer NOT NULL,
	"sensitivity" text NOT NULL,
	"retain_until" text,
	"source_updated_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "semantic_index_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"projection_version" integer NOT NULL,
	"status" text NOT NULL,
	"document_count" integer DEFAULT 0 NOT NULL,
	"vector_count" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"ready_at" text,
	"activated_at" text,
	"retired_at" text,
	"failure_reason" text
);
--> statement-breakpoint
CREATE TABLE "semantic_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"index_id" text NOT NULL,
	"kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"source_revision" text,
	"content_fingerprint" text,
	"projection_version" integer,
	"requested_at" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" text,
	"retry_after" text,
	"last_error" text,
	"outcome" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "semantic_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"index_id" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"checkpoint" text,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" text,
	"error_message" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"started_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "semantic_vectors" (
	"id" text PRIMARY KEY NOT NULL,
	"index_id" text NOT NULL,
	"document_id" text NOT NULL,
	"document_version" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"source_revision" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"projection_version" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"sensitivity" text NOT NULL,
	"embedding" text NOT NULL,
	"norm" text NOT NULL,
	"source_updated_at" text NOT NULL,
	"embedded_at" text NOT NULL,
	"index_run_id" text,
	"intent_id" text,
	"expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_score_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"task_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" text,
	"well_known_list_name" text,
	"group_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"last_known_remote_name" text,
	"user_display_name" text,
	"icon" text,
	"icon_color" text
);
--> statement-breakpoint
CREATE TABLE "source_rankings" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_type" text NOT NULL,
	"name" text NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtask_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text,
	"type" text DEFAULT 'single' NOT NULL,
	"subtasks" jsonb NOT NULL,
	"workflow_tasks" jsonb,
	"icon" text,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_deletion_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"task_id" text NOT NULL,
	"source_id" text NOT NULL,
	"first_missing_at" text NOT NULL,
	"last_missing_at" text NOT NULL,
	"missing_count" integer DEFAULT 1 NOT NULL,
	"identity_mode" text,
	"identity_mode_revision" integer,
	"issue_entity_id" text,
	"repository_entity_id" text,
	"host_key" text,
	"locator_revision" integer,
	"binding_state" text,
	"binding_revision" text
);
--> statement-breakpoint
CREATE TABLE "sync_deletion_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"original_task_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"source_id" text NOT NULL,
	"task_title" text NOT NULL,
	"reason" text NOT NULL,
	"task_data" jsonb NOT NULL,
	"relationship_data" jsonb NOT NULL,
	"deleted_at" text NOT NULL,
	"restored_at" text,
	"restored_task_id" text,
	"restore_mode" text,
	"identity_mode" text,
	"identity_mode_revision" integer,
	"issue_entity_id" text,
	"repository_entity_id" text,
	"host_key" text,
	"locator_revision" integer,
	"binding_state" text,
	"binding_revision" text,
	"recovery_state" text DEFAULT 'pending' NOT NULL,
	"recovery_claim_token" text,
	"recovery_validation" text,
	"quarantine_reason" text,
	"recovery_claimed_at" text
);
--> statement-breakpoint
CREATE TABLE "sync_job_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text,
	"connector_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"full" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" text,
	"cancel_requested_at" text,
	"started_at" text,
	"completed_at" text,
	"result" jsonb,
	"error" text,
	"duration_budget_ms" integer DEFAULT 300000 NOT NULL,
	"identity_mode" text,
	"identity_mode_revision" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"success" boolean NOT NULL,
	"tasks_added" integer DEFAULT 0 NOT NULL,
	"tasks_updated" integer DEFAULT 0 NOT NULL,
	"tasks_removed" integer DEFAULT 0 NOT NULL,
	"tasks_pushed" integer DEFAULT 0 NOT NULL,
	"local_only_protected" integer DEFAULT 0 NOT NULL,
	"alerts_added" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" text NOT NULL,
	"duration_ms" integer,
	"job_id" text,
	"trigger" text,
	"scheduled_for" text,
	"started_at" text,
	"attempt" integer,
	"max_attempts" integer,
	"identity_mode" text,
	"identity_mode_revision" integer
);
--> statement-breakpoint
CREATE TABLE "sync_schedules" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"interval_minutes" integer NOT NULL,
	"next_due_at" text NOT NULL,
	"last_enqueued_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"source" text,
	"color" text,
	"confirmed" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"unified_into" text
);
--> statement-breakpoint
CREATE TABLE "task_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"content_base64" text,
	"source_attachment_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"depends_on_task_id" text NOT NULL,
	"type" text DEFAULT 'blocks' NOT NULL,
	"connector_instance_id" text,
	"sync_status" text DEFAULT 'local' NOT NULL,
	"sync_action" text,
	"sync_error" text,
	"last_synced_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_field_states" (
	"task_id" text NOT NULL,
	"field_name" text NOT NULL,
	"source_value" text NOT NULL,
	"locally_overridden" boolean DEFAULT false NOT NULL,
	"source_observed_at" text,
	"local_edited_at" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "task_field_states_task_id_field_name_pk" PRIMARY KEY("task_id","field_name")
);
--> statement-breakpoint
CREATE TABLE "task_history_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"event_type" text NOT NULL,
	"field_name" text,
	"previous_value" text,
	"new_value" text,
	"project_id" text,
	"phase_id" text,
	"occurred_at" text NOT NULL,
	"recorded_at" text NOT NULL,
	"provenance" text NOT NULL,
	"provenance_ref" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "task_ingest_suppressions" (
	"connector_instance_id" text NOT NULL,
	"source_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "task_ingest_suppressions_connector_instance_id_source_id_pk" PRIMARY KEY("connector_instance_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "task_linked_source_entities" (
	"linked_source_id" text PRIMARY KEY NOT NULL,
	"connector_instance_id" text NOT NULL,
	"external_entity_id" text NOT NULL,
	"verified_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_linked_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"connector_instance_id" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"linked_at" text NOT NULL,
	"match_confidence" double precision,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_projects" (
	"task_id" text NOT NULL,
	"project_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_reminder_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"scheduled_at" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claimed_at" text,
	"lease_expires_at" text,
	"fired_at" text,
	"cancelled_at" text,
	"notification_id" text,
	"last_error" text,
	"next_attempt_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_schedules" (
	"task_id" text PRIMARY KEY NOT NULL,
	"scheduled_date" text NOT NULL,
	"scheduled_time" text,
	"estimated_duration" integer,
	"is_time_blocked" boolean DEFAULT false NOT NULL,
	"recurrence" text,
	"recurrence_mode" text DEFAULT 'schedule' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_search_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"source_list_name" text,
	"connector_type" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B') || setweight(to_tsvector('english', coalesce(source_list_name, '') || ' ' || coalesce(connector_type, '')), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "task_source_write_lease_targets" (
	"lease_id" text NOT NULL,
	"role" text NOT NULL,
	"external_entity_id" text,
	"repository_entity_id" text,
	"host_key" text,
	"locator_revision" integer,
	"binding_revision" text,
	"legacy_locator_digest" text,
	"owner" text,
	"repository" text,
	"issue_number" integer,
	CONSTRAINT "task_source_write_lease_targets_lease_id_role_pk" PRIMARY KEY("lease_id","role"),
	CONSTRAINT "task_source_write_lease_targets_role_check" CHECK ("task_source_write_lease_targets"."role" IN ('primary_issue', 'parent_issue', 'blocker_issue', 'blocked_issue', 'source_repository', 'target_repository')),
	CONSTRAINT "task_source_write_lease_targets_locator_check" CHECK ("task_source_write_lease_targets"."locator_revision" IS NULL OR "task_source_write_lease_targets"."locator_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_source_write_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"connector_instance_id" text NOT NULL,
	"task_id" text NOT NULL,
	"operation" text NOT NULL,
	"task_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"mode_revision" integer NOT NULL,
	"write_cycle_id" text,
	"state" text DEFAULT 'claimed' NOT NULL,
	"cycle_observed_at" text,
	"cycle_outcome" text,
	"intent_kind" text,
	"intent_digest" text,
	"result_digest" text,
	"block_reason" text,
	"unknown_reason" text,
	"dispatched_at" text,
	"finalized_at" text,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "task_source_write_leases_operation_check" CHECK ("task_source_write_leases"."operation" IN ('create', 'update', 'complete', 'delete', 'label', 'comment', 'dependency', 'sub_issue', 'transfer')),
	CONSTRAINT "task_source_write_leases_state_check" CHECK ("task_source_write_leases"."state" IN ('claimed', 'authorized', 'dispatched', 'succeeded', 'failed', 'blocked', 'unknown', 'expired')),
	CONSTRAINT "task_source_write_leases_reason_check" CHECK (("task_source_write_leases"."block_reason" IS NULL OR length("task_source_write_leases"."block_reason") <= 100)
      AND ("task_source_write_leases"."unknown_reason" IS NULL OR length("task_source_write_leases"."unknown_reason") <= 100))
);
--> statement-breakpoint
CREATE TABLE "task_tags" (
	"task_id" text NOT NULL,
	"tag_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"connector_instance_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED,
	"status" text DEFAULT 'todo' NOT NULL,
	"local_disposition" text DEFAULT 'active' NOT NULL,
	"priority" text DEFAULT 'none' NOT NULL,
	"planning_horizon" text,
	"due_date" text,
	"push_count" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text,
	"recurrence_generated_from_task_id" text,
	"parent_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"is_checklist_item" boolean DEFAULT false NOT NULL,
	"source_list_id" text,
	"source_list_name" text,
	"assignee" text,
	"micro_status" text,
	"status_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_synced_at" text NOT NULL,
	"push_retry_count" integer DEFAULT 0 NOT NULL,
	"kanban_column" text,
	"kanban_order" double precision,
	"snoozed_until" text,
	"reminder_at" text,
	"reminder_relative" text,
	"reminder_due_time" text,
	"effort" integer,
	"is_bulk_import" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_action_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"triage_item_id" text NOT NULL,
	"action_type" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claimed_at" text NOT NULL,
	"completed_at" text,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "triage_content_types" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text DEFAULT '#6b7280' NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"url_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keyword_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_items" (
	"id" text PRIMARY KEY NOT NULL,
	"source_platform" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text NOT NULL,
	"canonical_url" text,
	"title" text NOT NULL,
	"description" text,
	"thumbnail_url" text,
	"content_type" text DEFAULT 'link' NOT NULL,
	"captured_at" text NOT NULL,
	"ingested_at" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"snoozed_until" text,
	"ai_summary" text,
	"ai_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_suggested_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_relevance_score" integer DEFAULT 0 NOT NULL,
	"ai_urgency" text DEFAULT 'evergreen' NOT NULL,
	"raw_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions_taken" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_order" integer
);
--> statement-breakpoint
CREATE TABLE "triage_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_cursor" text,
	"last_synced_at" text,
	"total_imported" integer DEFAULT 0 NOT NULL,
	"total_skipped" integer DEFAULT 0 NOT NULL,
	"last_run_imported" integer DEFAULT 0 NOT NULL,
	"last_run_skipped" integer DEFAULT 0 NOT NULL,
	"last_run_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_duration_ms" integer,
	"revision" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_one_thing" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"week_monday" text NOT NULL,
	"is_manual_override" boolean DEFAULT false NOT NULL,
	"completed_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_todo_bridge_state" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"transport" text NOT NULL,
	"capability_profile" text NOT NULL,
	"list_delta_link" text,
	"reset_required" boolean DEFAULT false NOT NULL,
	"last_ingest_at" text,
	"last_ingest_mode" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_todo_list_delta_state" (
	"connector_id" text NOT NULL,
	"list_source_id" text NOT NULL,
	"delta_link" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "work_todo_list_delta_state_connector_id_list_source_id_pk" PRIMARY KEY("connector_id","list_source_id")
);
--> statement-breakpoint
CREATE TABLE "work_todo_outbound_changes" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"task_id" text NOT NULL,
	"source_id" text NOT NULL,
	"list_source_id" text NOT NULL,
	"remote_task_id" text NOT NULL,
	"operation" text NOT NULL,
	"fields" jsonb,
	"task_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_id" text,
	"leased_at" text,
	"lease_expires_at" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"acknowledged_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_health_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"generated_at" text NOT NULL,
	"worker_instance_id" text NOT NULL,
	"worker_revision" text NOT NULL,
	"generation_duration_ms" integer NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_dispatch_attempts" ADD CONSTRAINT "agent_dispatch_attempts_dispatch_id_agent_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."agent_dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_dispatch_events" ADD CONSTRAINT "agent_dispatch_events_dispatch_id_agent_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."agent_dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_dispatches" ADD CONSTRAINT "agent_dispatches_external_agent_id_external_agents_id_fk" FOREIGN KEY ("external_agent_id") REFERENCES "public"."external_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_sessions" ADD CONSTRAINT "ai_provider_sessions_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run_events" ADD CONSTRAINT "ai_run_events_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_maintenance_locks" ADD CONSTRAINT "connector_maintenance_locks_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_maintenance_locks" ADD CONSTRAINT "connector_maintenance_locks_operation_id_github_repository_repoints_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."github_repository_repoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_controls" ADD CONSTRAINT "connector_sync_controls_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_operator_runs" ADD CONSTRAINT "connector_sync_operator_runs_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_operator_runs" ADD CONSTRAINT "connector_sync_operator_runs_job_id_sync_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_reconciliation_candidates" ADD CONSTRAINT "dependency_reconciliation_candidates_snapshot_id_dependency_reconciliation_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."dependency_reconciliation_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_reconciliation_edges" ADD CONSTRAINT "dependency_reconciliation_edges_snapshot_id_dependency_reconciliation_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."dependency_reconciliation_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_reconciliation_items" ADD CONSTRAINT "dependency_reconciliation_items_snapshot_id_dependency_reconciliation_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."dependency_reconciliation_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_entity_bindings" ADD CONSTRAINT "external_entity_bindings_external_entity_id_external_entities_id_fk" FOREIGN KEY ("external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_entity_bindings" ADD CONSTRAINT "external_entity_bindings_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_entity_locators" ADD CONSTRAINT "external_entity_locators_external_entity_id_external_entities_id_fk" FOREIGN KEY ("external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_entity_locators" ADD CONSTRAINT "external_entity_locators_repository_entity_id_external_entities_id_fk" FOREIGN KEY ("repository_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_insight_cutover_audit" ADD CONSTRAINT "finance_insight_cutover_audit_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_insight_publication_delivery" ADD CONSTRAINT "finance_insight_publication_delivery_publication_id_finance_insight_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."finance_insight_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_insight_publication_facts" ADD CONSTRAINT "finance_insight_publication_facts_publication_id_finance_insight_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."finance_insight_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_insight_transaction_projection_facts" ADD CONSTRAINT "finance_insight_transaction_projection_facts_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_insight_transaction_projection_state" ADD CONSTRAINT "finance_insight_transaction_projection_state_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_insight_transaction_projection_windows" ADD CONSTRAINT "finance_insight_transaction_projection_windows_connector_id_connector_configs_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_insight_transaction_window_proofs" ADD CONSTRAINT "finance_insight_transaction_window_proofs_plan_id_finance_insight_transaction_backfill_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."finance_insight_transaction_backfill_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_bulk_transfer_events" ADD CONSTRAINT "github_bulk_transfer_events_run_id_github_bulk_transfer_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."github_bulk_transfer_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_bulk_transfer_items" ADD CONSTRAINT "github_bulk_transfer_items_run_id_github_bulk_transfer_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."github_bulk_transfer_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_bulk_transfer_items" ADD CONSTRAINT "github_bulk_transfer_items_issue_entity_id_external_entities_id_fk" FOREIGN KEY ("issue_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_bulk_transfer_runs" ADD CONSTRAINT "github_bulk_transfer_runs_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_bulk_transfer_successions" ADD CONSTRAINT "github_bulk_transfer_successions_run_id_github_bulk_transfer_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."github_bulk_transfer_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_bulk_transfer_successions" ADD CONSTRAINT "github_bulk_transfer_successions_source_external_entity_id_external_entities_id_fk" FOREIGN KEY ("source_external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_bulk_transfer_successions" ADD CONSTRAINT "github_bulk_transfer_successions_successor_external_entity_id_external_entities_id_fk" FOREIGN KEY ("successor_external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_bulk_transfer_successions" ADD CONSTRAINT "github_bulk_transfer_successions_target_repository_entity_id_external_entities_id_fk" FOREIGN KEY ("target_repository_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_backfill_items" ADD CONSTRAINT "github_identity_backfill_items_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_backfill_items" ADD CONSTRAINT "github_identity_backfill_items_external_entity_id_external_entities_id_fk" FOREIGN KEY ("external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_collisions" ADD CONSTRAINT "github_identity_collisions_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_controls" ADD CONSTRAINT "github_identity_controls_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_exception_events" ADD CONSTRAINT "github_identity_exception_events_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_migrations" ADD CONSTRAINT "github_identity_migrations_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_mode_events" ADD CONSTRAINT "github_identity_mode_events_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_task_transfer_reconciliations" ADD CONSTRAINT "github_identity_task_transfer_reconciliations_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_task_transfer_reconciliations" ADD CONSTRAINT "github_identity_task_transfer_reconciliations_source_external_entity_id_external_entities_id_fk" FOREIGN KEY ("source_external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_task_transfer_reconciliations" ADD CONSTRAINT "github_identity_task_transfer_reconciliations_successor_external_entity_id_external_entities_id_fk" FOREIGN KEY ("successor_external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_write_cycles" ADD CONSTRAINT "github_identity_write_cycles_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repository_repoint_events" ADD CONSTRAINT "github_repository_repoint_events_operation_id_github_repository_repoints_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."github_repository_repoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repository_repoints" ADD CONSTRAINT "github_repository_repoints_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repository_repoints" ADD CONSTRAINT "github_repository_repoints_repository_entity_id_external_entities_id_fk" FOREIGN KEY ("repository_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_write_outcome_events" ADD CONSTRAINT "github_write_outcome_events_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_write_outcome_events" ADD CONSTRAINT "github_write_outcome_events_cycle_id_github_identity_write_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."github_identity_write_cycles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_write_outcome_events" ADD CONSTRAINT "github_write_outcome_events_lease_id_task_source_write_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."task_source_write_leases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_workspace_versions" ADD CONSTRAINT "graph_workspace_versions_workspace_id_graph_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."graph_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_events" ADD CONSTRAINT "notification_delivery_events_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_search_documents" ADD CONSTRAINT "notification_search_documents_notification_id_fk" FOREIGN KEY ("id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_writeback_jobs" ADD CONSTRAINT "notification_writeback_jobs_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_reconciliation_evaluations" ADD CONSTRAINT "scout_reconciliation_evaluations_run_id_scout_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scout_reconciliation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_reconciliation_suggestions" ADD CONSTRAINT "scout_reconciliation_suggestions_run_id_scout_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scout_reconciliation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scout_reconciliation_suggestions" ADD CONSTRAINT "scout_reconciliation_suggestions_evaluation_id_scout_reconciliation_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."scout_reconciliation_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_documents" ADD CONSTRAINT "semantic_documents_index_id_semantic_index_identities_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."semantic_index_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_intents" ADD CONSTRAINT "semantic_intents_index_id_semantic_index_identities_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."semantic_index_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_runs" ADD CONSTRAINT "semantic_runs_index_id_semantic_index_identities_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."semantic_index_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_vectors" ADD CONSTRAINT "semantic_vectors_index_id_semantic_index_identities_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."semantic_index_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_vectors" ADD CONSTRAINT "semantic_vectors_document_id_semantic_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."semantic_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_lists" ADD CONSTRAINT "source_lists_group_id_list_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."list_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_job_events" ADD CONSTRAINT "sync_job_events_job_id_sync_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_states" ADD CONSTRAINT "task_field_states_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_linked_source_entities" ADD CONSTRAINT "task_linked_source_entities_linked_source_id_task_linked_sources_id_fk" FOREIGN KEY ("linked_source_id") REFERENCES "public"."task_linked_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_linked_source_entities" ADD CONSTRAINT "task_linked_source_entities_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_linked_source_entities" ADD CONSTRAINT "task_linked_source_entities_external_entity_id_external_entities_id_fk" FOREIGN KEY ("external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reminder_occurrences" ADD CONSTRAINT "task_reminder_occurrences_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_search_documents" ADD CONSTRAINT "task_search_documents_task_id_fk" FOREIGN KEY ("id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_write_lease_targets" ADD CONSTRAINT "task_source_write_lease_targets_lease_id_task_source_write_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."task_source_write_leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_write_lease_targets" ADD CONSTRAINT "task_source_write_lease_targets_external_entity_id_external_entities_id_fk" FOREIGN KEY ("external_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_write_lease_targets" ADD CONSTRAINT "task_source_write_lease_targets_repository_entity_id_external_entities_id_fk" FOREIGN KEY ("repository_entity_id") REFERENCES "public"."external_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_write_leases" ADD CONSTRAINT "task_source_write_leases_connector_instance_id_connector_configs_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_source_write_leases" ADD CONSTRAINT "task_source_write_leases_write_cycle_id_github_identity_write_cycles_id_fk" FOREIGN KEY ("write_cycle_id") REFERENCES "public"."github_identity_write_cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_action_claims" ADD CONSTRAINT "triage_action_claims_triage_item_id_triage_items_id_fk" FOREIGN KEY ("triage_item_id") REFERENCES "public"."triage_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_dispatch_attempt_number" ON "agent_dispatch_attempts" USING btree ("dispatch_id","attempt_number");--> statement-breakpoint
CREATE INDEX "idx_agent_dispatch_attempt_status" ON "agent_dispatch_attempts" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "idx_agent_dispatch_events_dispatch" ON "agent_dispatch_events" USING btree ("dispatch_id","id");--> statement-breakpoint
CREATE INDEX "idx_agent_dispatch_events_created" ON "agent_dispatch_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_dispatches_agent_idempotency" ON "agent_dispatches" USING btree ("external_agent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_agent_dispatches_status_available" ON "agent_dispatches" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_dispatches_lease" ON "agent_dispatches" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_agent_dispatches_provider_task" ON "agent_dispatches" USING btree ("provider_task_id");--> statement-breakpoint
CREATE INDEX "idx_agent_dispatches_completed" ON "agent_dispatches" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "idx_ai_provider_sessions_expiry" ON "ai_provider_sessions" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "idx_ai_provider_sessions_provider" ON "ai_provider_sessions" USING btree ("provider","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_run_events_event_id" ON "ai_run_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_run_events_sequence" ON "ai_run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_run_events_idempotency" ON "ai_run_events" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_ai_run_events_cursor" ON "ai_run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "idx_ai_run_events_created" ON "ai_run_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ai_runs_idempotency" ON "ai_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_ai_runs_claim" ON "ai_runs" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_runs_lease" ON "ai_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_ai_runs_correlation" ON "ai_runs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "idx_ai_runs_history" ON "ai_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_runs_expiry" ON "ai_runs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_ai_runs_cleanup" ON "ai_runs" USING btree ("cleanup_status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_alertmanager_integration_events_history" ON "alertmanager_integration_events" USING btree ("integration","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_alertmanager_integration_events_outcome" ON "alertmanager_integration_events" USING btree ("integration","kind","outcome","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "apns_registrations_installation_target_idx" ON "apns_registrations" USING btree ("installation_id","environment","topic");--> statement-breakpoint
CREATE INDEX "apns_registrations_token_target_idx" ON "apns_registrations" USING btree ("token_hash","environment","topic");--> statement-breakpoint
CREATE INDEX "apns_registrations_active_idx" ON "apns_registrations" USING btree ("environment","topic","invalidated_at");--> statement-breakpoint
CREATE INDEX "apns_registrations_installation_idx" ON "apns_registrations" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connector_maintenance_locks_operation" ON "connector_maintenance_locks" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "idx_connector_operation_leases_expiry" ON "connector_operation_leases" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_connector_sync_controls_state" ON "connector_sync_controls" USING btree ("scheduler_state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connector_sync_operator_idempotency" ON "connector_sync_operator_runs" USING btree ("connector_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connector_sync_operator_canary" ON "connector_sync_operator_runs" USING btree ("connector_id","quarantine_id","operation") WHERE "connector_sync_operator_runs"."operation" = 'canary';--> statement-breakpoint
CREATE INDEX "idx_connector_sync_operator_connector" ON "connector_sync_operator_runs" USING btree ("connector_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_dependency_snapshot_candidate_dependency" ON "dependency_reconciliation_candidates" USING btree ("dependency_id");--> statement-breakpoint
CREATE INDEX "idx_dependency_snapshot_edge_blocked" ON "dependency_reconciliation_edges" USING btree ("snapshot_id","blocked_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_dependency_snapshot_item_source" ON "dependency_reconciliation_items" USING btree ("snapshot_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_dependency_snapshot_active_connector" ON "dependency_reconciliation_snapshots" USING btree ("connector_instance_id") WHERE "dependency_reconciliation_snapshots"."status" IN ('running', 'failed');--> statement-breakpoint
CREATE INDEX "idx_dependency_snapshot_connector_updated" ON "dependency_reconciliation_snapshots" USING btree ("connector_instance_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_dependency_snapshot_connector_status_completed" ON "dependency_reconciliation_snapshots" USING btree ("connector_instance_id","status","completed_at");--> statement-breakpoint
CREATE INDEX "idx_dependency_snapshot_resume" ON "dependency_reconciliation_snapshots" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_external_agents_enabled" ON "external_agents" USING btree ("enabled","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_external_agents_transport" ON "external_agents" USING btree ("transport");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_entities_identity" ON "external_entities" USING btree ("provider","host_key","entity_type","stable_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_bindings_local" ON "external_entity_bindings" USING btree ("connector_instance_id","binding_type","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_bindings_entity" ON "external_entity_bindings" USING btree ("connector_instance_id","external_entity_id");--> statement-breakpoint
CREATE INDEX "idx_external_bindings_external_entity" ON "external_entity_bindings" USING btree ("external_entity_id");--> statement-breakpoint
CREATE INDEX "idx_external_bindings_state" ON "external_entity_bindings" USING btree ("connector_instance_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_locators_revision" ON "external_entity_locators" USING btree ("external_entity_id","locator_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_locators_current" ON "external_entity_locators" USING btree ("external_entity_id") WHERE "external_entity_locators"."valid_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_locators_current_repository" ON "external_entity_locators" USING btree ("provider","host_key","owner_key","repository_key") WHERE "external_entity_locators"."valid_to" IS NULL AND "external_entity_locators"."issue_number" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_locators_current_issue" ON "external_entity_locators" USING btree ("provider","host_key","owner_key","repository_key","issue_number") WHERE "external_entity_locators"."valid_to" IS NULL AND "external_entity_locators"."issue_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_external_locators_repository_issue" ON "external_entity_locators" USING btree ("repository_entity_id","issue_number","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_accounts_connector_upstream" ON "finance_accounts" USING btree ("connector_id","upstream_account_id");--> statement-breakpoint
CREATE INDEX "idx_finance_accounts_connector_active" ON "finance_accounts" USING btree ("connector_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_attention_repair_idempotency" ON "finance_attention_repair_audit" USING btree ("connector_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_finance_attention_repair_connector" ON "finance_attention_repair_audit" USING btree ("connector_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_attribution_audit_idempotency" ON "finance_attribution_audit" USING btree ("connector_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_finance_attribution_audit_transaction" ON "finance_attribution_audit" USING btree ("connector_id","transaction_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_attribution_exception_current" ON "finance_attribution_exceptions" USING btree ("connector_id","transaction_id");--> statement-breakpoint
CREATE INDEX "idx_finance_attribution_exception_queue" ON "finance_attribution_exceptions" USING btree ("connector_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_finance_attribution_attention_scan" ON "finance_attribution_exceptions" USING btree ("connector_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_attribution_subject_unique" ON "finance_attribution_subjects" USING btree ("connector_id","kid_id");--> statement-breakpoint
CREATE INDEX "idx_finance_attribution_subject_policy" ON "finance_attribution_subjects" USING btree ("connector_id","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_budgets_generation_category" ON "finance_budget_snapshots" USING btree ("connector_id","generation_id","period_start","upstream_category_id");--> statement-breakpoint
CREATE INDEX "idx_finance_budgets_current" ON "finance_budget_snapshots" USING btree ("connector_id","is_current","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_categories_connector_upstream" ON "finance_categories" USING btree ("connector_id","upstream_category_id");--> statement-breakpoint
CREATE INDEX "idx_finance_categories_connector_active" ON "finance_categories" USING btree ("connector_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_finance_categories_connector_group" ON "finance_categories" USING btree ("connector_id","upstream_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_category_groups_connector_upstream" ON "finance_category_groups" USING btree ("connector_id","upstream_group_id");--> statement-breakpoint
CREATE INDEX "idx_finance_category_groups_connector_active" ON "finance_category_groups" USING btree ("connector_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_finance_connection_outages_status" ON "finance_connection_outages" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_finance_dataset_state_freshness" ON "finance_dataset_sync_state" USING btree ("connector_id","fresh_until");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_insight_cutover_audit_idempotency" ON "finance_insight_cutover_audit" USING btree ("connector_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_cutover_audit_connector" ON "finance_insight_cutover_audit" USING btree ("connector_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_cutover_delivery" ON "finance_insight_cutovers" USING btree ("delivery_enabled","updated_at");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_occurrence_connector_updated" ON "finance_insight_occurrences" USING btree ("connector_id","source_updated_at");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_occurrence_connector_lifecycle" ON "finance_insight_occurrences" USING btree ("connector_id","source_lifecycle","source_updated_at");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_occurrence_connector_series" ON "finance_insight_occurrences" USING btree ("connector_id","insight_id","source_updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_insight_delivery_connector_sequence" ON "finance_insight_publication_delivery" USING btree ("connector_id","source_sequence");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_delivery_stage" ON "finance_insight_publication_delivery" USING btree ("connector_id","stage","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_insight_publication_fact_position" ON "finance_insight_publication_facts" USING btree ("publication_id","kind","batch_index","fact_index");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_publication_fact_batch" ON "finance_insight_publication_facts" USING btree ("publication_id","kind","batch_index");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_insight_publication_connector_sequence" ON "finance_insight_publications" USING btree ("connector_id","source_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_insight_publication_connector_identity" ON "finance_insight_publications" USING btree ("connector_id","generation_identity");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_publication_connector_captured" ON "finance_insight_publications" USING btree ("connector_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_insight_backfill_plan_idempotency" ON "finance_insight_transaction_backfill_plans" USING btree ("connector_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_backfill_plan_status" ON "finance_insight_transaction_backfill_plans" USING btree ("connector_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_transaction_projection_date" ON "finance_insight_transaction_projection_facts" USING btree ("connector_id","generation_id","occurred_on");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_transaction_projection_status" ON "finance_insight_transaction_projection_state" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_insight_transaction_window_coverage" ON "finance_insight_transaction_projection_windows" USING btree ("connector_id","generation_id","coverage_start","coverage_end");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_insight_window_generation" ON "finance_insight_transaction_window_proofs" USING btree ("connector_id","generation_ref");--> statement-breakpoint
CREATE INDEX "idx_finance_insight_window_coverage" ON "finance_insight_transaction_window_proofs" USING btree ("connector_id","window_start","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_mutation_idempotency" ON "finance_mutation_audit" USING btree ("connector_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_finance_mutation_status" ON "finance_mutation_audit" USING btree ("connector_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_finance_mutation_transaction" ON "finance_mutation_audit" USING btree ("transaction_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_finance_mutation_attention_scan" ON "finance_mutation_audit" USING btree ("connector_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_recurring_generation_upstream" ON "finance_recurring_obligations" USING btree ("connector_id","generation_id","upstream_recurring_id");--> statement-breakpoint
CREATE INDEX "idx_finance_recurring_current" ON "finance_recurring_obligations" USING btree ("connector_id","is_current");--> statement-breakpoint
CREATE INDEX "idx_finance_sync_state_status" ON "finance_sync_state" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_tags_connector_upstream" ON "finance_tags" USING btree ("connector_id","upstream_tag_id");--> statement-breakpoint
CREATE INDEX "idx_finance_tags_connector_active" ON "finance_tags" USING btree ("connector_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_transactions_connector_upstream" ON "finance_transactions" USING btree ("connector_instance_id","upstream_transaction_id");--> statement-breakpoint
CREATE INDEX "idx_finance_transactions_connector_date" ON "finance_transactions" USING btree ("connector_instance_id","date");--> statement-breakpoint
CREATE INDEX "idx_finance_transactions_connector_lifecycle" ON "finance_transactions" USING btree ("connector_instance_id","lifecycle_status","date");--> statement-breakpoint
CREATE INDEX "idx_finance_transactions_generation" ON "finance_transactions" USING btree ("connector_instance_id","last_seen_generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_finance_transactions_connector_source_ref" ON "finance_transactions" USING btree ("connector_instance_id","attribution_source_ref");--> statement-breakpoint
CREATE INDEX "idx_finance_transactions_attribution_review" ON "finance_transactions" USING btree ("connector_instance_id","attribution_review_state","attribution_updated_at");--> statement-breakpoint
CREATE INDEX "idx_focus_items_task_id" ON "focus_items" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_github_bulk_transfer_events_run" ON "github_bulk_transfer_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_bulk_transfer_items_issue" ON "github_bulk_transfer_items" USING btree ("run_id","issue_stable_id");--> statement-breakpoint
CREATE INDEX "idx_github_bulk_transfer_items_state" ON "github_bulk_transfer_items" USING btree ("run_id","state","source_number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_bulk_transfer_runs_idempotency" ON "github_bulk_transfer_runs" USING btree ("connector_instance_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_bulk_transfer_runs_active_connector" ON "github_bulk_transfer_runs" USING btree ("connector_instance_id") WHERE "github_bulk_transfer_runs"."phase" = 'running';--> statement-breakpoint
CREATE INDEX "idx_github_bulk_transfer_runs_phase" ON "github_bulk_transfer_runs" USING btree ("phase","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_bulk_transfer_successions_item" ON "github_bulk_transfer_successions" USING btree ("run_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_bulk_transfer_successions_idempotency" ON "github_bulk_transfer_successions" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_github_bulk_transfer_successions_source" ON "github_bulk_transfer_successions" USING btree ("source_external_entity_id");--> statement-breakpoint
CREATE INDEX "idx_github_bulk_transfer_successions_successor" ON "github_bulk_transfer_successions" USING btree ("successor_external_entity_id");--> statement-breakpoint
CREATE INDEX "idx_github_backfill_items_state" ON "github_identity_backfill_items" USING btree ("connector_instance_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_github_backfill_items_entity" ON "github_identity_backfill_items" USING btree ("external_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_identity_collisions_fingerprint" ON "github_identity_collisions" USING btree ("connector_instance_id","category","fingerprint");--> statement-breakpoint
CREATE INDEX "idx_github_identity_collisions_state" ON "github_identity_collisions" USING btree ("connector_instance_id","state","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_identity_exception_events_idempotency" ON "github_identity_exception_events" USING btree ("connector_instance_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_github_identity_exception_events_local" ON "github_identity_exception_events" USING btree ("connector_instance_id","binding_type","local_id","id");--> statement-breakpoint
CREATE INDEX "idx_github_identity_migrations_phase" ON "github_identity_migrations" USING btree ("phase","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_identity_mode_events_idempotency" ON "github_identity_mode_events" USING btree ("connector_instance_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_github_identity_mode_events_connector" ON "github_identity_mode_events" USING btree ("connector_instance_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_task_transfer_reconciliations_idempotency" ON "github_identity_task_transfer_reconciliations" USING btree ("connector_instance_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_task_transfer_reconciliations_source" ON "github_identity_task_transfer_reconciliations" USING btree ("connector_instance_id","source_task_id");--> statement-breakpoint
CREATE INDEX "idx_github_task_transfer_reconciliations_successor" ON "github_identity_task_transfer_reconciliations" USING btree ("connector_instance_id","successor_task_id");--> statement-breakpoint
CREATE INDEX "idx_github_identity_write_cycles_connector" ON "github_identity_write_cycles" USING btree ("connector_instance_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_identity_write_cycles_active" ON "github_identity_write_cycles" USING btree ("connector_instance_id") WHERE "github_identity_write_cycles"."state" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_identity_write_cycles_reconciliation_key" ON "github_identity_write_cycles" USING btree ("connector_instance_id","reconciliation_idempotency_key") WHERE "github_identity_write_cycles"."reconciliation_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_github_repository_repoint_events_operation" ON "github_repository_repoint_events" USING btree ("operation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_repository_repoints_idempotency" ON "github_repository_repoints" USING btree ("connector_instance_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_repository_repoints_active_connector" ON "github_repository_repoints" USING btree ("connector_instance_id") WHERE "github_repository_repoints"."phase" IN ('locked', 'applying', 'applied', 'verifying', 'verification_failed', 'rolling_back');--> statement-breakpoint
CREATE INDEX "idx_github_repository_repoints_phase" ON "github_repository_repoints" USING btree ("phase","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_write_outcome_events_connector_key" ON "github_write_outcome_events" USING btree ("connector_instance_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_write_outcome_events_lease" ON "github_write_outcome_events" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "idx_github_write_outcome_events_cycle" ON "github_write_outcome_events" USING btree ("cycle_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_graph_workspace_versions_revision" ON "graph_workspace_versions" USING btree ("workspace_id","revision");--> statement-breakpoint
CREATE INDEX "idx_graph_workspace_versions_history" ON "graph_workspace_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_graph_workspaces_migration_source" ON "graph_workspaces" USING btree ("migration_source");--> statement-breakpoint
CREATE INDEX "idx_graph_workspaces_library" ON "graph_workspaces" USING btree ("archived_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_homelab_alert_receipts_event" ON "homelab_alert_receipts" USING btree ("integration","source","event_id");--> statement-breakpoint
CREATE INDEX "idx_homelab_alert_receipts_incident" ON "homelab_alert_receipts" USING btree ("integration","source","fingerprint","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_homelab_alert_receipts_received" ON "homelab_alert_receipts" USING btree ("last_received_at");--> statement-breakpoint
CREATE INDEX "idx_houston_memories_scope_updated" ON "houston_conversation_memories" USING btree ("authorization_scope","updated_at");--> statement-breakpoint
CREATE INDEX "idx_houston_memories_retention" ON "houston_conversation_memories" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "idx_houston_memories_excluded" ON "houston_conversation_memories" USING btree ("excluded_at");--> statement-breakpoint
CREATE INDEX "idx_houston_finance_action_call" ON "houston_finance_action_audit" USING btree ("call_hash","created_at");--> statement-breakpoint
CREATE INDEX "idx_houston_finance_action_correlation" ON "houston_finance_action_audit" USING btree ("correlation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_houston_finance_pending_expiry" ON "houston_finance_pending_approvals" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inbound_webhook_replays_delivery" ON "inbound_webhook_replays" USING btree ("webhook_id","delivery_key");--> statement-breakpoint
CREATE INDEX "idx_inbound_webhook_replays_expiry" ON "inbound_webhook_replays" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_maintenance_agent_runs_active" ON "maintenance_agent_runs" USING btree ("agent_type") WHERE "maintenance_agent_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_maintenance_agent_runs_resume" ON "maintenance_agent_runs" USING btree ("agent_type","dry_run","started_at");--> statement-breakpoint
CREATE INDEX "idx_maintenance_agent_runs_history" ON "maintenance_agent_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "native_installation_credentials_installation_idx" ON "native_installation_credentials" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "native_push_requests_created_idx" ON "native_push_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "native_share_capture_requests_created_idx" ON "native_share_capture_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "native_share_credentials_installation_idx" ON "native_share_credentials" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_notification_actions_notification" ON "notification_actions" USING btree ("notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_delivery_events_dedupe" ON "notification_delivery_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_events_dispatch" ON "notification_delivery_events" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_events_notification" ON "notification_delivery_events" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_events_created_at" ON "notification_delivery_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_push_rules_connector" ON "notification_push_rules" USING btree ("connector_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_push_rules_connector_template" ON "notification_push_rules" USING btree ("connector_instance_id","template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_saved_views_name" ON "notification_saved_views" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_notification_saved_views_updated_at" ON "notification_saved_views" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_notification_search_documents_vector" ON "notification_search_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_writeback_jobs_dedupe" ON "notification_writeback_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_notification_writeback_jobs_dispatch" ON "notification_writeback_jobs" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_notification_writeback_jobs_connector" ON "notification_writeback_jobs" USING btree ("connector_instance_id","status");--> statement-breakpoint
CREATE INDEX "idx_notification_writeback_jobs_notification" ON "notification_writeback_jobs" USING btree ("notification_id","status");--> statement-breakpoint
CREATE INDEX "idx_notifications_search_vector" ON "notifications" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notifications_source_id" ON "notifications" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_state" ON "notifications" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_notifications_sort_at" ON "notifications" USING btree ("state","sort_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_inbox" ON "notifications" USING btree ("disposition","source_state","snoozed_until","sort_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_attention" ON "notifications" USING btree ("disposition","source_state","read_state","level");--> statement-breakpoint
CREATE INDEX "idx_notifications_level" ON "notifications" USING btree ("level");--> statement-breakpoint
CREATE INDEX "idx_notifications_category" ON "notifications" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_notifications_received_at" ON "notifications" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_connector" ON "notifications" USING btree ("connector_type");--> statement-breakpoint
CREATE INDEX "idx_notifications_dedupe" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_notifications_reconcile_source" ON "notifications" USING btree ("connector_instance_id","source_state","last_reconciled_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_related_task_id" ON "notifications" USING btree ("related_task_id");--> statement-breakpoint
CREATE INDEX "idx_priority_sync_log_task_id" ON "priority_sync_log" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_auto_include_exclusions_project_task" ON "project_auto_include_exclusions" USING btree ("project_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_project_auto_include_exclusions_task" ON "project_auto_include_exclusions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_project_hierarchy_commands_project_revision" ON "project_hierarchy_commands" USING btree ("project_id","result_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_phase_items_phase_task" ON "project_phase_items" USING btree ("phase_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_quick_sort_operations_task_created" ON "quick_sort_operations" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_instances_role_started" ON "runtime_telemetry_instances" USING btree ("role","started_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_instances_last_seen" ON "runtime_telemetry_instances" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_runtime_samples_instance_time_resolution" ON "runtime_telemetry_samples" USING btree ("instance_id","sampled_at","resolution_seconds");--> statement-breakpoint
CREATE INDEX "idx_runtime_samples_role_time" ON "runtime_telemetry_samples" USING btree ("role","sampled_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_samples_time" ON "runtime_telemetry_samples" USING btree ("sampled_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_telemetry_samples_time" ON "runtime_telemetry_samples" USING btree ("sampled_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_telemetry_samples_role_time" ON "runtime_telemetry_samples" USING btree ("role","sampled_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_telemetry_samples_role_id" ON "runtime_telemetry_samples" USING btree ("role","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scout_reconciliation_evaluation_run_task" ON "scout_reconciliation_evaluations" USING btree ("run_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_scout_reconciliation_evaluation_task_time" ON "scout_reconciliation_evaluations" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_scout_reconciliation_evaluation_action_time" ON "scout_reconciliation_evaluations" USING btree ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scout_reconciliation_run_idempotency" ON "scout_reconciliation_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scout_reconciliation_active_scope" ON "scout_reconciliation_runs" USING btree ("scope_key") WHERE "scout_reconciliation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_scout_reconciliation_run_scope_time" ON "scout_reconciliation_runs" USING btree ("scope_key","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scout_reconciliation_pending_task" ON "scout_reconciliation_suggestions" USING btree ("task_id") WHERE "scout_reconciliation_suggestions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_scout_reconciliation_suggestion_status_time" ON "scout_reconciliation_suggestions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_scout_reconciliation_suggestion_evidence" ON "scout_reconciliation_suggestions" USING btree ("task_id","evidence_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_documents_entity" ON "semantic_documents" USING btree ("index_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_semantic_documents_kind" ON "semantic_documents" USING btree ("index_id","entity_type","source_updated_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_documents_retention" ON "semantic_documents" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "idx_semantic_documents_deleted" ON "semantic_documents" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_identities_active" ON "semantic_index_identities" USING btree ("status") WHERE "semantic_index_identities"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_semantic_identities_lifecycle" ON "semantic_index_identities" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_identities_space" ON "semantic_index_identities" USING btree ("provider","model","dimensions","projection_version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_intents_pending" ON "semantic_intents" USING btree ("idempotency_key") WHERE "semantic_intents"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_semantic_intents_claim" ON "semantic_intents" USING btree ("index_id","status","available_at","requested_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_intents_lease" ON "semantic_intents" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_intents_entity" ON "semantic_intents" USING btree ("index_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_semantic_intents_history" ON "semantic_intents" USING btree ("status","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_runs_idempotency" ON "semantic_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_runs_active" ON "semantic_runs" USING btree ("index_id","kind") WHERE "semantic_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_semantic_runs_claim" ON "semantic_runs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_runs_lease" ON "semantic_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_runs_history" ON "semantic_runs" USING btree ("index_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_vectors_entity" ON "semantic_vectors" USING btree ("index_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_semantic_vectors_scan" ON "semantic_vectors" USING btree ("index_id","entity_type","source_updated_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_vectors_document" ON "semantic_vectors" USING btree ("document_id","document_version");--> statement-breakpoint
CREATE INDEX "idx_semantic_vectors_expiry" ON "semantic_vectors" USING btree ("index_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_semantic_vectors_job" ON "semantic_vectors" USING btree ("index_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sync_deletion_candidate_source" ON "sync_deletion_candidates" USING btree ("connector_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_sync_deletion_candidate_task" ON "sync_deletion_candidates" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_sync_deletion_candidate_fence" ON "sync_deletion_candidates" USING btree ("connector_id","identity_mode_revision","issue_entity_id");--> statement-breakpoint
CREATE INDEX "idx_sync_deletion_snapshot_task" ON "sync_deletion_snapshots" USING btree ("original_task_id");--> statement-breakpoint
CREATE INDEX "idx_sync_deletion_snapshot_deleted" ON "sync_deletion_snapshots" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "idx_sync_deletion_snapshot_recovery" ON "sync_deletion_snapshots" USING btree ("connector_id","recovery_state","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_sync_job_events_cursor" ON "sync_job_events" USING btree ("id");--> statement-breakpoint
CREATE INDEX "idx_sync_job_events_job" ON "sync_job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sync_jobs_active_connector" ON "sync_jobs" USING btree ("connector_id","status") WHERE "sync_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "idx_sync_jobs_claim" ON "sync_jobs" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_sync_jobs_lease" ON "sync_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_sync_jobs_completed" ON "sync_jobs" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "idx_sync_log_job_id" ON "sync_log" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_sync_log_connector_success_synced_at" ON "sync_log" USING btree ("connector_id","success","synced_at");--> statement-breakpoint
CREATE INDEX "idx_sync_log_connector_synced_at" ON "sync_log" USING btree ("connector_id","synced_at");--> statement-breakpoint
CREATE INDEX "idx_sync_schedules_next_due" ON "sync_schedules" USING btree ("next_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_dependencies_pair_type" ON "task_dependencies" USING btree ("task_id","depends_on_task_id","type");--> statement-breakpoint
CREATE INDEX "idx_task_dependencies_depends_on" ON "task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE INDEX "idx_task_field_states_task_id" ON "task_field_states" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_task_history_task_time" ON "task_history_events" USING btree ("task_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "idx_task_history_type_time" ON "task_history_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_task_history_project_time" ON "task_history_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_task_history_phase_time" ON "task_history_events" USING btree ("phase_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_history_planning_signal_once" ON "task_history_events" USING btree ("task_id","event_type","new_value") WHERE "task_history_events"."event_type" IN ('my_day_missed', 'focus_missed', 'scheduled_block_elapsed', 'became_overdue');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_history_planning_observation_once" ON "task_history_events" USING btree ("task_id","event_type","new_value","occurred_at") WHERE "task_history_events"."event_type" IN ('my_day_committed', 'my_day_withdrawn', 'focus_committed', 'focus_withdrawn');--> statement-breakpoint
CREATE INDEX "idx_task_history_planning_date" ON "task_history_events" USING btree ("event_type","new_value") WHERE "task_history_events"."event_type" IN ('my_day_committed', 'my_day_withdrawn', 'focus_committed', 'focus_withdrawn');--> statement-breakpoint
CREATE INDEX "idx_task_ingest_suppressions_source" ON "task_ingest_suppressions" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_linked_source_entities_connector_entity" ON "task_linked_source_entities" USING btree ("connector_instance_id","external_entity_id");--> statement-breakpoint
CREATE INDEX "idx_task_linked_source_entities_entity" ON "task_linked_source_entities" USING btree ("external_entity_id");--> statement-breakpoint
CREATE INDEX "idx_task_linked_source_entities_connector" ON "task_linked_source_entities" USING btree ("connector_instance_id","linked_source_id");--> statement-breakpoint
CREATE INDEX "idx_task_linked_sources_task_id" ON "task_linked_sources" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_linked_sources_unique" ON "task_linked_sources" USING btree ("task_id","connector_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_linked_sources_source_identity" ON "task_linked_sources" USING btree ("connector_instance_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_projects_task_project" ON "task_projects" USING btree ("task_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_reminder_occurrences_task_schedule" ON "task_reminder_occurrences" USING btree ("task_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_task_reminder_occurrences_claim" ON "task_reminder_occurrences" USING btree ("state","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_task_search_documents_vector" ON "task_search_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "idx_task_source_write_lease_targets_entity" ON "task_source_write_lease_targets" USING btree ("external_entity_id","repository_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_source_write_leases_token" ON "task_source_write_leases" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_source_write_leases_task_operation_active" ON "task_source_write_leases" USING btree ("connector_instance_id","task_id","operation") WHERE "task_source_write_leases"."state" IN ('claimed', 'authorized', 'dispatched', 'unknown');--> statement-breakpoint
CREATE INDEX "idx_task_source_write_leases_connector_expiry" ON "task_source_write_leases" USING btree ("connector_instance_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "idx_task_source_write_leases_operator" ON "task_source_write_leases" USING btree ("connector_instance_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_task_source_write_leases_cycle" ON "task_source_write_leases" USING btree ("write_cycle_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_search_vector" ON "tasks" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tasks_source_connector" ON "tasks" USING btree ("source_id","connector_instance_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_local_disposition" ON "tasks" USING btree ("local_disposition");--> statement-breakpoint
CREATE INDEX "idx_tasks_planning_horizon" ON "tasks" USING btree ("planning_horizon");--> statement-breakpoint
CREATE INDEX "idx_tasks_list_counts" ON "tasks" USING btree ("is_checklist_item","connector_instance_id","source_list_id","status");--> statement-breakpoint
CREATE INDEX "idx_tasks_due_reminder" ON "tasks" USING btree ("reminder_at","status") WHERE "tasks"."reminder_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_tasks_push_count" ON "tasks" USING btree ("push_count") WHERE "tasks"."push_count" >= 2;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tasks_recurrence_generated_from" ON "tasks" USING btree ("recurrence_generated_from_task_id") WHERE "tasks"."recurrence_generated_from_task_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_triage_action_claims_item_action" ON "triage_action_claims" USING btree ("triage_item_id","action_type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_triage_items_source" ON "triage_items" USING btree ("source_platform","source_id");--> statement-breakpoint
CREATE INDEX "idx_triage_items_canonical_url" ON "triage_items" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "idx_weekly_one_thing_task_id" ON "weekly_one_thing" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_work_todo_list_delta_connector" ON "work_todo_list_delta_state" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_work_todo_change_task_version" ON "work_todo_outbound_changes" USING btree ("connector_id","task_id","task_version");--> statement-breakpoint
CREATE INDEX "idx_work_todo_change_ready" ON "work_todo_outbound_changes" USING btree ("connector_id","status","lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_work_todo_change_task" ON "work_todo_outbound_changes" USING btree ("task_id");