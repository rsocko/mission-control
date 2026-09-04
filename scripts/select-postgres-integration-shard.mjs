import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RUNTIME_MS = 500;
const FILE_STARTUP_MS = 1_000;
const POSTGRES_TEST_PATTERN = /^postgres-.*\.integration\.test\.ts$/u;

// Runtime observations from successful CI runs. Unknown files still participate
// automatically and receive a conservative startup-weight estimate.
export const POSTGRES_TEST_RUNTIME_MS = Object.freeze({
  'postgres-connection.integration.test.ts': 30,
  'postgres-connector-execution.integration.test.ts': 306,
  'postgres-connector-operation-lease-repository.contract.integration.test.ts': 109,
  'postgres-connector-operation-lease-repository.integration.test.ts': 66,
  'postgres-core-repositories.integration.test.ts': 179,
  'postgres-durable-ai-run-repository.integration.test.ts': 369,
  'postgres-event-outbox-repository.integration.test.ts': 1_746,
  'postgres-external-agent-control-repository.integration.test.ts': 113,
  'postgres-finance-assistant-persistence.integration.test.ts': 3_282,
  'postgres-finance-attention-persistence.integration.test.ts': 354,
  'postgres-finance-insight-notification-lifecycle.integration.test.ts': 209,
  'postgres-finance-insight-persistence.integration.test.ts': 545,
  'postgres-finance-worker-execution.integration.test.ts': 6_773,
  'postgres-finance-worker-persistence.integration.test.ts': 280,
  'postgres-github-dependency-repositories.integration.test.ts': 164,
  'postgres-github-hierarchy-repositories.integration.test.ts': 228,
  'postgres-github-identity-repositories.integration.test.ts': 1_023,
  'postgres-github-project-repositories.integration.test.ts': 195,
  'postgres-github-recovery-repositories.integration.test.ts': 748,
  'postgres-github-sync-pipeline.integration.test.ts': 2_648,
  'postgres-github-worker-execution.integration.test.ts': 822,
  'postgres-health-snapshot-data.integration.test.ts': 96,
  'postgres-ideation-workspace-repository.integration.test.ts': 329,
  'postgres-notification-delivery-repository.integration.test.ts': 1_642,
  'postgres-notification-enrichment.integration.test.ts': 1_746,
  'postgres-notification-entity-linking-repository.integration.test.ts': 295,
  'postgres-notification-web-repository.integration.test.ts': 0,
  'postgres-packaged-workflow-parity.integration.test.ts': 91_105,
  'postgres-planning-project-automation.integration.test.ts': 214,
  'postgres-project-hierarchy-repository.integration.test.ts': 522,
  'postgres-relative-reminder-timezone-repository.integration.test.ts': 1_704,
  'postgres-schema.integration.test.ts': 88,
  'postgres-search-repository.integration.test.ts': 219,
  'postgres-semantic-index-repository.integration.test.ts': 876,
  'postgres-semantic-worker-runtime.integration.test.ts': 52_151,
  'postgres-sqlite-to-postgres-import.integration.test.ts': 2_284,
  'postgres-sync-job-repository.contract.integration.test.ts': 187,
  'postgres-sync-job-repository.integration.test.ts': 256,
  'postgres-sync-operator-control.integration.test.ts': 155,
  'postgres-sync-run-repository.integration.test.ts': 59,
  'postgres-task-core.integration.test.ts': 10_013,
  'postgres-task-reminder-repository.integration.test.ts': 2_052,
  'postgres-telemetry-runtime.integration.test.ts': 69,
  'postgres-transaction-runner.integration.test.ts': 1_060,
  'postgres-transfer-identity.integration.test.ts': 569,
  'postgres-triage-persistence.integration.test.ts': 355,
  'postgres-triage-scheduler-smoke.integration.test.ts': 2_494,
  'postgres-web-sync-composition.integration.test.ts': 1_655,
  'postgres-work-todo-repositories.integration.test.ts': 1_150,
  'postgres-worker-healthcheck.integration.test.ts': 57,
});

export function estimatedPostgresTestWeight(file) {
  return (POSTGRES_TEST_RUNTIME_MS[file] ?? DEFAULT_RUNTIME_MS) + FILE_STARTUP_MS;
}

export function partitionPostgresIntegrationTests(files, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new TypeError('PostgreSQL shard count must be a positive integer');
  }
  if (new Set(files).size !== files.length) {
    throw new Error('PostgreSQL integration test file list contains duplicates');
  }

  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index,
    weight: 0,
    files: [],
  }));
  const weightedFiles = [...files]
    .map((file) => ({ file, weight: estimatedPostgresTestWeight(file) }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));

  for (const weightedFile of weightedFiles) {
    const target = [...shards].sort(
      (left, right) => left.weight - right.weight || left.index - right.index,
    )[0];
    target.files.push(weightedFile.file);
    target.weight += weightedFile.weight;
  }

  return shards.map((shard) => shard.files.sort());
}

async function main() {
  const shardIndex = Number(process.argv[2]);
  const shardCount = Number(process.argv[3]);
  if (
    !Number.isInteger(shardIndex) ||
    !Number.isInteger(shardCount) ||
    shardIndex < 1 ||
    shardIndex > shardCount
  ) {
    throw new Error('Usage: node scripts/select-postgres-integration-shard.mjs <index> <count>');
  }

  const testDirectory = path.resolve('tests', 'db');
  const files = (await readdir(testDirectory)).filter((file) => POSTGRES_TEST_PATTERN.test(file));
  const selected = partitionPostgresIntegrationTests(files, shardCount)[shardIndex - 1];
  if (selected.length === 0) {
    throw new Error(`PostgreSQL integration shard ${shardIndex}/${shardCount} is empty`);
  }
  process.stdout.write(`${selected.map((file) => `tests/db/${file}`).join('\n')}\n`);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === entrypoint) {
  await main();
}
