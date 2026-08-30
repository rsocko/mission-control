import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
    expect(help.stdout).toContain('status');
    expect(help.stdout).toContain('write-cycle-reconcile');
    expect(help.stdout).toContain('write-outcome-inspect');
    expect(help.stdout).toContain('write-outcome-resolve');
    expect(help.stdout).toContain('transfer-reconcile');
    expect(help.stdout).toContain('--successor-local-id');
    expect(help.stdout).toContain('--confirm-pre-dispatch');
    expect(help.stdout).toContain('--confirm-owner-stopped');
    expect(help.stdout).toContain('--confirm-authoritative-deletion');
    // The cutover is permanent: no mode, rollback, or comparison commands exist.
    expect(help.stdout).not.toContain('stable-enable');
    expect(help.stdout).not.toContain('stable-rollback');
    expect(help.stdout).not.toContain('observe-enable');
    expect(help.stdout).not.toContain('comparison-cycle-reconcile');

    const status = runOperator('status', '--connector', 'operator-artifact');
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      connectorInstanceId: 'operator-artifact',
      identity: { model: 'github_node_id', permanent: true, effectiveMode: 'stable' },
    });
    expect(status.stdout).not.toContain('operator-secret');
  });

  it('rejects removed mode and rollback commands', () => {
    for (const command of [
      'stable-enable',
      'stable-rollback',
      'rollback-reenter',
      'observe-enable',
      'observe-pause',
      'comparison-cycle-reconcile',
      'evidence',
    ]) {
      const result = runOperator(command, '--connector', 'operator-artifact');
      expect(result.status, command).toBe(2);
      expect(result.stderr).toContain('Unsupported command');
    }
  });

  it('rejects authoritative-deletion confirmation when revoking an exception', () => {
    const result = runOperator(
      'exception-revoke',
      '--connector', 'operator-artifact',
      '--local-id', 'task-1',
      '--actor', 'artifact-test',
      '--reason', 'Unconfirmed deletion',
      '--idempotency-key', 'artifact-exception-1',
      '--confirm-authoritative-deletion',
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      '--confirm-authoritative-deletion is valid only for exception-accept',
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

  it('fails closed on an unreachable PostgreSQL backend without touching SQLite', () => {
    const sqliteFallbackPath = join(directory, 'must-not-create.db');
    const result = runOperatorWithEnvironment({
      MC_DATABASE_BACKEND: 'postgres',
      MC_POSTGRES_URL: 'postgres://test:test@127.0.0.1:1/mission_control',
      MC_DB_PATH: sqliteFallbackPath,
      MC_DB_STARTUP_MAX_ATTEMPTS: '1',
    }, 'status', '--connector', 'operator-artifact');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('connect ECONNREFUSED 127.0.0.1:1');
    expect(result.stderr).not.toContain('worker.js');
    expect(existsSync(sqliteFallbackPath)).toBe(false);
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
      'Confirmation flags are not valid for write-outcome-inspect',
    );
  });
});

function runOperator(...args: string[]) {
  return runOperatorWithEnvironment({}, ...args);
}

function runOperatorWithEnvironment(
  overrides: Partial<NodeJS.ProcessEnv>,
  ...args: string[]
) {
  return spawnSync(
    process.execPath,
    ['--conditions=react-server', artifactPath, ...args],
    {
      cwd: process.cwd(),
      env: { ...environment, ...overrides },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
}
