import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('drizzle-orm');

const directory = mkdtempSync(join(tmpdir(), 'mc-identity-operator-'));
const databasePath = join(directory, 'mission-control.db');
const artifactPath = resolve('dist/github-identity-operator.cjs');
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  MC_DB_PATH: databasePath,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'production' as const,
};

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  process.env.LOG_LEVEL = 'silent';
  const [{ default: db, sqlite }, schema] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
  ]);
  const now = '2026-08-10T12:00:00.000Z';
  db.insert(schema.connectorConfigs).values({
    id: 'operator-artifact',
    type: 'github-issues',
    name: 'Operator artifact',
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: { token: 'operator-secret' },
    settings: { repos: [] },
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: 'operator-artifact',
    phase: 'backfilling',
    updatedAt: now,
  }).run();
  db.insert(schema.githubIdentityComparisonRuns).values({
    id: 'artifact-empty-failure',
    connectorInstanceId: 'operator-artifact',
    identityMode: 'comparison',
    identityModeRevision: 4,
    syncKind: 'incremental',
    state: 'failed',
    evidenceEligible: false,
    ownerId: 'runtime:artifact-owner',
    ownerTokenDigest: 'a'.repeat(64),
    ownerHeartbeatAt: '2026-08-10T10:00:00.000Z',
    ownerLeaseExpiresAt: '2026-08-10T10:15:00.000Z',
    interruptionState: 'unresolved',
    interruptionSurface: 'comparison',
    interruptedAt: now,
    interruptionReason: 'artifact_test_failure',
    startedAt: now,
    completedAt: now,
  }).run();
  sqlite.close();
  const build = spawnSync(process.execPath, ['scripts/build-github-identity-operator.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(build.stderr || 'Identity operator build failed');
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('production GitHub identity operator artifact', () => {
  it('is built, packaged by Docker, and invocable without npm or TypeScript', () => {
    expect(statSync(artifactPath).size).toBeGreaterThan(0);
    const dockerfile = readFileSync(resolve('Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY --from=builder /app/dist ./dist');
    const smoke = readFileSync(resolve('scripts/smoke-sync-worker-runtime.mjs'), 'utf8');
    expect(smoke).toContain('dist/github-identity-operator.cjs');

    const help = runOperator('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('stable-enable');
    expect(help.stdout).toContain('stable-rollback');
    expect(help.stdout).toContain('write-cycle-reconcile');
    expect(help.stdout).toContain('write-outcome-inspect');
    expect(help.stdout).toContain('write-outcome-resolve');
    expect(help.stdout).toContain('comparison-cycle-reconcile');
    expect(help.stdout).toContain('transfer-reconcile');
    expect(help.stdout).toContain('--successor-local-id');
    expect(help.stdout).toContain('--confirm-pre-dispatch');
    expect(help.stdout).toContain('--confirm-owner-stopped');
    expect(help.stdout).toContain('--confirm-authoritative-deletion');
    expect(help.stdout).toContain('--confirm-no-write');

    const status = runOperator('status', '--connector', 'operator-artifact');
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      mode: {
        effectiveMode: 'legacy',
        stablePrimaryEnabled: false,
      },
      stageTwo: { eligible: false },
    });
    expect(status.stdout).not.toContain('operator-secret');

    const enabled = runOperator(
      'observe-enable',
      '--connector', 'operator-artifact',
      '--revision', '0',
      '--actor', 'artifact-test',
      '--reason', 'Stage 1 test gate passed',
      '--idempotency-key', 'artifact-enable-1',
      '--stage-one-ready',
    );
    expect(enabled.status).toBe(0);
    expect(JSON.parse(enabled.stdout)).toMatchObject({
      snapshot: {
        effectiveMode: 'comparison',
        stablePrimaryEnabled: false,
        modeRevision: 1,
      },
    });
    const paused = runOperator(
      'observe-pause',
      '--connector', 'operator-artifact',
      '--revision', '1',
      '--actor', 'artifact-test',
      '--reason', 'Pause comparison test',
      '--idempotency-key', 'artifact-pause-1',
    );
    expect(paused.status).toBe(0);
    expect(JSON.parse(paused.stdout)).toMatchObject({
      snapshot: { effectiveMode: 'legacy', modeRevision: 2 },
    });
    const resumed = runOperator(
      'observe-enable',
      '--connector', 'operator-artifact',
      '--revision', '2',
      '--actor', 'artifact-test',
      '--reason', 'Resume comparison test',
      '--idempotency-key', 'artifact-enable-2',
      '--stage-one-ready',
    );
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      snapshot: {
        effectiveMode: 'comparison',
        stablePrimaryEnabled: false,
        modeRevision: 4,
      },
    });
  });

  it('exposes stable-primary only through the authoritative eligibility command', () => {
    const result = runOperator(
      'stable-enable',
      '--connector', 'operator-artifact',
      '--revision', '4',
      '--actor', 'artifact-test',
      '--reason', 'Attempt without Stage 2 evidence',
      '--idempotency-key', 'artifact-stable-blocked',
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('gate_failed');
  });

  it('requires paired post-backfill proof options before mutation', () => {
    const result = runOperator(
      'exception-accept',
      '--connector', 'operator-artifact',
      '--local-id', 'task-1',
      '--actor', 'artifact-test',
      '--reason', 'Unconfirmed deletion',
      '--idempotency-key', 'artifact-exception-1',
      '--comparison-run', 'comparison-run-1',
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'both --comparison-run and --confirm-authoritative-deletion',
    );
  });

  it('requires both exact task coordinates before historical transfer lookup', () => {
    const result = runOperator(
      'transfer-reconcile',
      '--connector', 'operator-artifact',
      '--revision', '4',
      '--actor', 'artifact-test',
      '--reason', 'Reconcile historical transfer',
      '--idempotency-key', 'artifact-transfer-reconciliation',
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--source-local-id is required');
    expect(result.stderr).not.toContain('operator-secret');
  });

  it('requires explicit pre-dispatch confirmation for interrupted cycles', () => {
    const result = runOperator(
      'write-cycle-reconcile',
      '--connector', 'operator-artifact',
      '--cycle', 'interrupted-cycle',
      '--revision', '4',
      '--actor', 'artifact-test',
      '--reason', 'Verified restart before dispatch',
      '--idempotency-key', 'artifact-cycle-reconciliation',
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('requires --confirm-pre-dispatch');
  });

  it('provides bounded read-only outcome inspection without connector credentials', () => {
    const result = runOperator(
      'write-outcome-inspect',
      '--connector', 'operator-artifact',
      '--limit', '5',
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      connectorInstanceId: 'operator-artifact',
      bounded: true,
      limit: 5,
      returnedCount: 0,
      outcomes: [],
    });
    expect(result.stdout).not.toContain('operator-secret');

    const unbounded = runOperator(
      'write-outcome-inspect',
      '--connector', 'operator-artifact',
      '--limit', '51',
    );
    expect(unbounded.status).toBe(2);
    expect(unbounded.stderr).toContain('--limit must not exceed 50');
  });

  it('requires complete audited resolution coordinates before any readback', () => {
    const result = runOperator(
      'write-outcome-resolve',
      '--connector', 'operator-artifact',
      '--revision', '4',
      '--actor', 'artifact-test',
      '--reason', 'Inspect the unresolved write outcome',
      '--idempotency-key', 'artifact-outcome-resolution',
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--cycle is required');
    expect(result.stderr).not.toContain('operator-secret');
  });

  it('rejects stopped-owner confirmation on read-only inspection', () => {
    const result = runOperator(
      'write-outcome-inspect',
      '--connector', 'operator-artifact',
      '--confirm-owner-stopped',
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      '--confirm-owner-stopped is not valid for write-outcome-inspect',
    );
  });

  it('requires an explicit comparison-cycle reconciliation action', () => {
    const result = runOperator(
      'comparison-cycle-reconcile',
      '--connector', 'operator-artifact',
      '--run', 'interrupted-run',
      '--revision', '4',
      '--actor', 'artifact-test',
      '--reason', 'Review interrupted comparison lineage',
      '--idempotency-key', 'artifact-comparison-reconciliation',
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('requires exactly one reconciliation confirmation');
  });

  it('ships the audited current-revision no-write reconciliation path', () => {
    const result = runOperator(
      'comparison-cycle-reconcile',
      '--connector', 'operator-artifact',
      '--run', 'artifact-empty-failure',
      '--revision', '4',
      '--actor', 'artifact-test',
      '--reason', 'Confirmed empty interrupted artifact run after owner expiry',
      '--idempotency-key', 'artifact-empty-failure-resolution',
      '--confirm-no-write',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      changed: true,
      runId: 'artifact-empty-failure',
      state: 'resolved',
      successorRunId: null,
    });
  });
});

function runOperator(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--conditions=react-server', artifactPath, ...args],
    {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
}
