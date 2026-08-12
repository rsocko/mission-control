import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.unmock('drizzle-orm');

const directory = mkdtempSync(join(tmpdir(), 'mc-github-identity-foundation-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identity: typeof import('@/lib/external-identities');

beforeAll(async () => {
  database = await import('@/db');
  schema = await import('@/db/schema');
  identity = await import('@/lib/external-identities');
  const now = '2026-08-09T10:00:00.000Z';
  database.default.insert(schema.connectorConfigs).values([
    connector('github-mode', now),
    connector('github-records', now),
  ]).run();
  database.default.insert(schema.githubIdentityMigrations).values([
    { connectorInstanceId: 'github-mode', phase: 'backfilling', updatedAt: now },
    { connectorInstanceId: 'github-records', phase: 'comparing', updatedAt: now },
  ]).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: 'github-records',
    stablePrimaryEnabled: false,
    modeRevision: 4,
    updatedAt: now,
  }).run();
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GitHub identity mode foundation', () => {
  it('defaults an existing connector to legacy with its stable flag off', () => {
    expect(identity.getGitHubIdentityModeSnapshot('github-mode')).toMatchObject({
      connectorInstanceId: 'github-mode',
      phase: 'backfilling',
      effectiveMode: 'legacy',
      stablePrimaryEnabled: false,
      modeRevision: 0,
    });
    expect(database.default.select().from(schema.githubIdentityControls)
      .where(eq(
        schema.githubIdentityControls.connectorInstanceId,
        'github-mode',
      )).all()).toEqual([]);
  });

  it('enforces gates, optimistic revisions, and idempotent transition events', () => {
    const request = {
      connectorInstanceId: 'github-mode',
      targetPhase: 'comparing' as const,
      stablePrimaryEnabled: false,
      expectedRevision: 0,
      actor: 'test-operator',
      reason: 'Stage 1 evidence approved',
      idempotencyKey: 'example-1',
      gate: { code: 'stage_one_ready' as const, passed: true },
      now: '2026-08-09T10:01:00.000Z',
    };
    const transitioned = identity.transitionGitHubIdentityMode(request);
    expect(transitioned).toMatchObject({
      ok: true,
      changed: true,
      snapshot: {
        phase: 'comparing',
        effectiveMode: 'comparison',
        stablePrimaryEnabled: false,
        modeRevision: 1,
      },
    });
    expect(identity.transitionGitHubIdentityMode(request)).toMatchObject({
      ok: true,
      changed: false,
      eventId: transitioned.ok ? transitioned.eventId : null,
    });
    expect(identity.transitionGitHubIdentityMode({
      ...request,
      stablePrimaryEnabled: true,
    })).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    expect(identity.transitionGitHubIdentityMode({
      ...request,
      idempotencyKey: 'example-2',
    })).toMatchObject({ ok: false, code: 'revision_conflict' });
    expect(identity.transitionGitHubIdentityMode({
      ...request,
      targetPhase: 'stable_primary',
      expectedRevision: 1,
      idempotencyKey: 'example-3',
      gate: { code: 'stage_two_ready', passed: true },
    })).toMatchObject({ ok: false, code: 'authoritative_command_required' });
    expect(database.default.select().from(schema.githubIdentityModeEvents).all()).toHaveLength(1);
  });

  it('keeps stable mode unreachable through the generic transition API', () => {
    const result = identity.transitionGitHubIdentityMode({
      connectorInstanceId: 'github-mode',
      targetPhase: 'stable_primary',
      stablePrimaryEnabled: true,
      expectedRevision: 1,
      actor: 'test-operator',
      reason: 'Stage 2 evidence approved',
      idempotencyKey: 'stable-transition-2',
      gate: { code: 'stage_two_ready', passed: true },
      now: '2026-08-09T10:02:00.000Z',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'authoritative_command_required',
      snapshot: { phase: 'comparing', modeRevision: 1 },
    });
  });

  it('requires the stable flag through compatibility and complete, then permits rollback', () => {
    const now = '2026-08-09T10:03:00.000Z';
    database.default.insert(schema.connectorConfigs).values(
      connector('github-stable-phases', now),
    ).run();
    database.default.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: 'github-stable-phases',
      phase: 'stable_primary',
      updatedAt: now,
    }).run();
    database.default.insert(schema.githubIdentityControls).values({
      connectorInstanceId: 'github-stable-phases',
      stablePrimaryEnabled: true,
      modeRevision: 4,
      updatedAt: now,
    }).run();

    const compatibility = {
      connectorInstanceId: 'github-stable-phases',
      targetPhase: 'compatibility' as const,
      expectedRevision: 4,
      actor: 'test-operator',
      reason: 'Stage 3 evidence approved',
      gate: { code: 'stage_three_ready' as const, passed: true },
      now,
    };
    expect(identity.transitionGitHubIdentityMode({
      ...compatibility,
      stablePrimaryEnabled: false,
      idempotencyKey: 'compatibility-flag-off',
    })).toMatchObject({ ok: false, code: 'stable_flag_required' });
    expect(identity.transitionGitHubIdentityMode({
      ...compatibility,
      stablePrimaryEnabled: true,
      idempotencyKey: 'compatibility-flag-on',
    })).toMatchObject({
      ok: true,
      snapshot: { phase: 'compatibility', effectiveMode: 'stable', modeRevision: 5 },
    });

    const complete = {
      connectorInstanceId: 'github-stable-phases',
      targetPhase: 'complete' as const,
      expectedRevision: 5,
      actor: 'test-operator',
      reason: 'Compatibility evidence approved',
      gate: { code: 'compatibility_ready' as const, passed: true },
      now,
    };
    expect(identity.transitionGitHubIdentityMode({
      ...complete,
      stablePrimaryEnabled: false,
      idempotencyKey: 'complete-flag-off',
    })).toMatchObject({ ok: false, code: 'stable_flag_required' });
    expect(identity.transitionGitHubIdentityMode({
      ...complete,
      stablePrimaryEnabled: true,
      idempotencyKey: 'complete-flag-on',
    })).toMatchObject({
      ok: true,
      snapshot: { phase: 'complete', effectiveMode: 'stable', modeRevision: 6 },
    });
    expect(identity.rollbackGitHubStablePrimary({
      connectorInstanceId: 'github-stable-phases',
      expectedRevision: 6,
      actor: 'test-operator',
      reason: 'Immediate rollback drill',
      idempotencyKey: 'rollback-stable-phase',
      now,
    })).toMatchObject({
      ok: true,
      snapshot: {
        phase: 'rollback_legacy',
        effectiveMode: 'legacy',
        stablePrimaryEnabled: false,
        modeRevision: 7,
      },
    });
  });

  it('derives cache generations from connector, mode, and revision', () => {
    expect(identity.createGitHubIdentityCacheGeneration({
      connectorInstanceId: 'github-mode',
      effectiveMode: 'comparison',
      modeRevision: 7,
    })).toBe('github-mode:comparison:7');
    expect(identity.createGitHubIdentityCacheGeneration({
      connectorInstanceId: 'github-mode',
      effectiveMode: 'comparison',
      modeRevision: 8,
    })).not.toBe('github-mode:comparison:7');
  });
});

describe('GitHub identity pure batch resolver', () => {
  const modeSnapshot = {
    connectorInstanceId: 'github-records',
    phase: 'comparing' as const,
    effectiveMode: 'comparison' as const,
    stablePrimaryEnabled: false,
    modeRevision: 4,
    capturedAt: '2026-08-09T11:00:00.000Z',
  };

  it('records disagreement while comparison mode remains legacy-authoritative', () => {
    const resolved = identity.resolveGitHubIdentityBatch({
      modeSnapshot,
      candidates: [{
        candidateKey: 'owner/repo:1',
        surface: 'task',
        legacy: { selectedLocalIds: ['legacy-task'], action: 'update' },
        stable: {
          selectedLocalIds: ['stable-task'],
          action: 'update',
          evidence: 'verified',
          stableIdDigest: 'a'.repeat(64),
          locatorRevision: 2,
        },
      }],
    });
    expect(resolved.decisions[0]).toMatchObject({
      outcome: 'stable_legacy_disagree',
      reason: 'selected_ids_differ',
      appliedSource: 'legacy',
      selectedLocalId: 'legacy-task',
    });
  });

  it.each([
    [{ evidence: 'missing' as const }, 'legacy_fallback', 'legacy'],
    [{ evidence: 'collision' as const }, 'collision', 'legacy'],
    [{ evidence: 'inaccessible' as const }, 'inaccessible', 'legacy'],
    [{ evidence: 'partial' as const }, 'partial_fetch', 'legacy'],
    [{ evidence: 'verified' as const, pathReused: true }, 'path_reuse', 'legacy'],
    [{ evidence: 'verified' as const, locatorChanged: true }, 'locator_change', 'legacy'],
  ])('classifies stable evidence without changing the legacy decision', (stable, outcome, appliedSource) => {
    const result = identity.resolveGitHubIdentityBatch({
      modeSnapshot,
      candidates: [{
        candidateKey: `candidate-${outcome}`,
        surface: 'task',
        legacy: { selectedLocalIds: ['task-1'], action: 'present' },
        stable: {
          selectedLocalIds: stable.evidence === 'missing' ? [] : ['task-1'],
          action: 'present',
          ...stable,
        },
      }],
    });
    expect(result.decisions[0]).toMatchObject({ outcome, appliedSource, selectedLocalId: 'task-1' });
  });

  it('blocks stable mode on disagreement and is deterministic', () => {
    const result = identity.resolveGitHubIdentityBatch({
      modeSnapshot: { ...modeSnapshot, effectiveMode: 'stable' },
      candidates: [{
        candidateKey: 'stable-disagreement',
        surface: 'task',
        legacy: { selectedLocalIds: ['task-b', 'task-a'], action: 'update' },
        stable: { selectedLocalIds: ['task-c'], action: 'update', evidence: 'verified' },
      }],
    });

    expect(result.decisions[0]).toMatchObject({
      outcome: 'collision',
      appliedSource: 'blocked',
      selectedLocalId: null,
      selectedAction: 'none',
    });
  });

  it.each([
    'source_list',
    'task',
    'project_association',
    'linked_source',
    'dependency',
    'sub_issue',
    'deletion',
    'write_route',
  ] as const)('applies the stable selection for the %s surface', (surface) => {
    const result = identity.resolveGitHubIdentityBatch({
      modeSnapshot: {
        ...modeSnapshot,
        phase: 'stable_primary',
        effectiveMode: 'stable',
        stablePrimaryEnabled: true,
      },
      candidates: [{
        candidateKey: `renamed-${surface}`,
        surface,
        legacy: { selectedLocalIds: [], action: 'none' },
        stable: {
          selectedLocalIds: ['preserved-local-id'],
          action: 'present',
          evidence: 'verified',
          bindingState: 'active',
          bindingRevision: '2026-08-09T11:00:00.000Z',
          locatorRevision: 2,
          locatorChanged: true,
        },
      }],
    });
    expect(result.decisions[0]).toMatchObject({
      outcome: 'locator_change',
      appliedSource: 'stable',
      selectedLocalId: 'preserved-local-id',
      selectedAction: 'present',
    });
  });

  it.each(['missing', 'collision', 'inaccessible', 'partial'] as const)(
    'fails stable mutation closed for %s evidence',
    (evidence) => {
      const result = identity.resolveGitHubIdentityBatch({
        modeSnapshot: {
          ...modeSnapshot,
          phase: 'stable_primary',
          effectiveMode: 'stable',
          stablePrimaryEnabled: true,
        },
        candidates: [{
          candidateKey: `blocked-${evidence}`,
          surface: 'task',
          legacy: { selectedLocalIds: ['legacy-task'], action: 'update' },
          stable: {
            selectedLocalIds: evidence === 'missing' ? [] : ['legacy-task'],
            action: 'update',
            evidence,
          },
        }],
      });
      expect(result.decisions[0]).toMatchObject({
        appliedSource: 'blocked',
        selectedLocalId: null,
        selectedAction: 'none',
      });
    },
  );

  it('does not report a locator change when neither resolver selected a local row', () => {
    const result = identity.resolveGitHubIdentityBatch({
      modeSnapshot: { ...modeSnapshot, effectiveMode: 'stable' },
      candidates: [{
        candidateKey: 'unbound-locator',
        surface: 'task',
        legacy: { selectedLocalIds: [], action: 'create' },
        stable: {
          selectedLocalIds: [],
          action: 'create',
          evidence: 'verified',
          locatorChanged: true,
        },
      }],
    });
    expect(result.decisions[0]).toMatchObject({
      outcome: 'agreement',
      appliedSource: 'stable',
      selectedLocalId: null,
      selectedAction: 'create',
    });
  });

  it('rejects raw stable identifiers from resolver diagnostics', () => {
    expect(() => identity.resolveGitHubIdentityBatch({
      modeSnapshot,
      candidates: [{
        candidateKey: 'raw-stable-id',
        surface: 'task',
        legacy: { selectedLocalIds: ['task-1'], action: 'present' },
        stable: {
          selectedLocalIds: ['task-1'],
          action: 'present',
          evidence: 'verified',
          stableIdDigest: 'I_raw_node_id',
        },
      }],
    })).toThrow('lowercase SHA-256');
  });
});

describe('GitHub identity comparison persistence', () => {
  it('persists typed append-only decisions and completes a run', () => {
    const run = identity.startGitHubIdentityComparisonRun({
      id: 'comparison-run-1',
      connectorInstanceId: 'github-records',
      jobId: 'job-1',
      identityMode: 'comparison',
      identityModeRevision: 4,
      syncKind: 'full',
      startedAt: '2026-08-09T12:00:00.000Z',
    });
    const records = identity.appendGitHubIdentityComparisonRecords(run.id, [{
      id: 'comparison-record-1',
      surface: 'task',
      candidateKey: 'owner/repo:1',
      legacySelectedLocalId: 'task-1',
      stableSelectedLocalId: 'task-1',
      legacyAction: 'update',
      stableAction: 'update',
      outcome: 'agreement',
      reason: 'exact_match',
      stableIdDigest: 'b'.repeat(64),
      locatorRevision: 1,
      legacyLookupMs: 2,
      stableLookupMs: 3,
      createdAt: '2026-08-09T12:00:01.000Z',
    }]);
    expect(records[0]).toMatchObject({
      outcome: 'agreement',
      stableIdDigest: 'b'.repeat(64),
    });
    expect(() => identity.appendGitHubIdentityComparisonRecords(run.id, [{
      surface: 'task',
      candidateKey: 'raw-stable-id',
      legacyAction: 'none',
      stableAction: 'none',
      outcome: 'agreement',
      reason: 'exact_match',
      stableIdDigest: 'I_raw_node_id',
    }])).toThrow('lowercase SHA-256');
    expect(() => identity.completeGitHubIdentityComparisonRun(run.id, {
      state: 'succeeded',
      pageCount: 1,
      queryCount: 2,
      outcomeCounts: { agreement: 2 },
      evidenceEligible: true,
    })).toThrow('does not match stored records');
    const transactionCountBefore = database.getDatabaseTelemetry()
      .operations.byCategory.transaction?.count ?? 0;
    expect(identity.completeGitHubIdentityComparisonRun(run.id, {
      state: 'succeeded',
      pageCount: 1,
      queryCount: 2,
      outcomeCounts: { agreement: 1 },
      evidenceEligible: true,
      completedAt: '2026-08-09T12:00:02.000Z',
    })).toMatchObject({
      state: 'succeeded',
      outcomeCounts: { agreement: 1 },
      evidenceEligible: true,
    });
    expect(database.getDatabaseTelemetry().operations.byCategory.transaction?.count)
      .toBe(transactionCountBefore + 1);
    expect(() => identity.appendGitHubIdentityComparisonRecords(run.id, [{
      surface: 'task',
      candidateKey: 'late-record',
      legacyAction: 'none',
      stableAction: 'none',
      outcome: 'agreement',
      reason: 'exact_match',
    }])).toThrow('is not running');
  });
});

function connector(id: string, now: string) {
  return {
    id,
    type: 'github-issues',
    name: id,
    enabled: true,
    syncMode: 'manual' as const,
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: { token: 'test-token' },
    settings: { repos: ['owner/repository'] },
    syncedLists: ['owner/repository'],
    createdAt: now,
    updatedAt: now,
  };
}
