import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';
import type {
  EvaluationRequestV1,
  EvaluationResultV1,
  InsightOccurrenceSummaryV1,
  OccurrenceListQueryV1,
  OccurrenceListResponseV1,
  SourceFactBatchV1,
  SourceFactKindV1,
  SourceGenerationCommitRequestV1,
  SourceGenerationCreateRequestV1,
} from '@/lib/finance-insights/contract';
import type { CanonicalJsonValue } from '@/lib/finance-insights/canonical';

vi.unmock('drizzle-orm');

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-insight-ingestion-'));
const databasePath = join(tempDirectory, 'ingestion.db');
const now = new Date('2026-08-10T12:05:00.000Z');
const sourceAsOf = '2026-08-10T12:00:00.000Z';
const publicationId = 'finance-publication-v1-invented';
const connectorId = 'finance-invented';
const occurrenceId = 'occurrence-v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const successorOccurrenceId = 'occurrence-v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const insightId = 'insight-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

let sqlite: Database.Database;
let runTransaction: typeof import('@/db')['runTransaction'];
let financeInsightDigestV1:
  typeof import('@/lib/finance-insights/canonical')['financeInsightDigestV1'];
let createNotificationsInTransaction:
  typeof import('@/lib/notifications/service')['createNotificationsInTransaction'];
let sourceGenerationCreateRequestSchema:
  typeof import('@/lib/finance-insights/contract')['sourceGenerationCreateRequestSchema'];
let runFinanceInsightIngestion:
  typeof import('@/lib/finance-insights/orchestrator')['runFinanceInsightIngestion'];
let enableFinanceInsightCutover:
  typeof import('@/lib/finance-insights/cutover')['enableFinanceInsightCutover'];
let rollbackFinanceInsightCutover:
  typeof import('@/lib/finance-insights/cutover')['rollbackFinanceInsightCutover'];
let isLegacyFinanceAnomalyProductionEnabled:
  typeof import('@/lib/finance-insights/cutover')['isLegacyFinanceAnomalyProductionEnabled'];
let buildFinanceInsightNotificationInput:
  typeof import('@/lib/finance-insights/notification-ingestion')['buildFinanceInsightNotificationInput'];
let buildFinanceMonthlyDigestInput:
  typeof import('@/lib/finance-insights/notification-ingestion')['buildFinanceMonthlyDigestInput'];
let getFinanceMonthlyDigestSchedule:
  typeof import('@/lib/finance-insights/notification-ingestion')['getFinanceMonthlyDigestSchedule'];
let isMaterialRecurringIncrease:
  typeof import('@/lib/finance-insights/notification-ingestion')['isMaterialRecurringIncrease'];
let selectFinanceInsightNotificationInputs:
  typeof import('@/lib/finance-insights/notification-ingestion')['selectFinanceInsightNotificationInputs'];
let syncFinanceProviderPresentation:
  typeof import(
    '@/db/persistence/sqlite-finance-insight-notification-lifecycle'
  )['syncFinanceProviderPresentation'];

function connector(id = connectorId): ConnectorConfig {
  return {
    id,
    type: 'finance-manager',
    name: 'Invented Finance',
    enabled: true,
    syncMode: 'poll',
    capabilities: {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: false,
      lists: false,
      tags: true,
      tagWriteBack: false,
      notificationOnly: true,
    },
    credentials: {},
    settings: {},
    syncedLists: [],
  };
}

function seedConnector(id = connectorId, type = 'finance-manager'): void {
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials,
      settings, synced_lists, created_at, updated_at
    ) VALUES (?, ?, 'Invented Finance', 1, 'poll', '{}', '{}', '{}', '[]', ?, ?)
  `).run(id, type, now.toISOString(), now.toISOString());
}

function sourceFacts(): Record<SourceFactKindV1, Record<string, unknown>> {
  return {
    transaction: {
      sourceRef: 'transaction-one',
      occurredOn: '2026-08-09',
      amountMinor: -184000,
      merchantName: 'Invented market',
      categoryRef: 'category-one',
      accountRef: 'account-one',
      isPending: false,
      recurringRef: null,
      tagRefs: ['tag-one'],
    },
    recurring: {
      sourceRef: 'recurring-one',
      displayName: 'Invented utility',
      amountMinor: -12000,
      cadence: 'monthly',
      nextDate: '2026-09-01',
      categoryRef: 'category-one',
      accountRef: 'account-one',
      active: true,
    },
    category: {
      sourceRef: 'category-one',
      displayName: 'Invented household',
      groupRef: null,
      active: true,
    },
    account: {
      sourceRef: 'account-one',
      accountType: 'checking',
      active: true,
    },
    tag: {
      sourceRef: 'tag-one',
      displayName: 'Invented reviewed',
      active: true,
    },
  };
}

function seedPublication(): void {
  const facts = sourceFacts();
  const kinds = Object.keys(facts) as SourceFactKindV1[];
  const capturedConstituents = kinds.map((kind) => ({
    kind,
    generationRef: `${kind}-generation-one`,
    sourceAsOf,
    itemCount: 1,
    digest: financeInsightDigestV1([facts[kind]] as CanonicalJsonValue),
  }));
  const manifest = kinds.map((kind) => ({
    kind,
    batchCount: 1,
    itemCount: 1,
    digest: financeInsightDigestV1([
      financeInsightDigestV1([facts[kind]] as CanonicalJsonValue),
    ]),
  }));
  const createRequest = sourceGenerationCreateRequestSchema.parse({
    contractVersion: '1.0',
    connectorRef: connectorId,
    sourceGeneration: publicationId,
    sourceSequence: 1,
    sourceAsOf,
    coverageStart: '2026-08-01',
    coverageEnd: '2026-08-10',
    currency: 'USD',
    bridgeContractVersion: 'bridge-v1',
    capturedConstituents,
    manifest,
    idempotencyKey: 'finance-generation-v1-invented',
  });
  sqlite.prepare(`
    INSERT INTO finance_insight_publications (
      id, connector_id, source_sequence, generation_identity, contract_version,
      provider_type, source_as_of, coverage_start, coverage_end, currency,
      bridge_contract_version, captured_constituents, manifest, manifest_digest,
      create_request, idempotency_key, alert_capable, captured_at, expires_at
    ) VALUES (?, ?, 1, 'identity-one', '1.0', 'finance-manager', ?, '2026-08-01',
      '2026-08-10', 'USD', 'bridge-v1', ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    publicationId,
    connectorId,
    sourceAsOf,
    JSON.stringify(capturedConstituents),
    JSON.stringify(manifest),
    financeInsightDigestV1(manifest as CanonicalJsonValue),
    JSON.stringify(createRequest),
    createRequest.idempotencyKey,
    now.toISOString(),
    '2026-08-17T12:05:00.000Z',
  );
  const insertFact = sqlite.prepare(`
    INSERT INTO finance_insight_publication_facts (
      publication_id, kind, source_ref, batch_index, fact_index, payload
    ) VALUES (?, ?, ?, 0, 0, ?)
  `);
  for (const kind of kinds) {
    insertFact.run(publicationId, kind, facts[kind].sourceRef, JSON.stringify(facts[kind]));
  }
}

function occurrence(
  overrides: Partial<InsightOccurrenceSummaryV1> = {},
): InsightOccurrenceSummaryV1 {
  return {
    contractVersion: '1.0',
    insightId,
    occurrenceId,
    deliveryRevision: 1,
    kind: 'largeTransaction',
    entity: {
      kind: 'transaction',
      sourceRef: 'transaction-one',
      displayName: 'Invented market',
      identityQuality: 'stableSource',
    },
    analysisState: 'qualified',
    sourceLifecycle: 'open',
    resolutionReason: null,
    supersededByOccurrenceId: null,
    severity: 'high',
    confidence: 'high',
    baselineSufficiency: 'sufficient',
    reasonCodes: ['explicit_amount_rule_exceeded'],
    headline: 'Invented household spending exception',
    explanation: 'An invented transaction exceeded the configured amount rule.',
    observationPeriod: { start: '2026-08-09', end: '2026-08-09' },
    baselinePeriod: null,
    observedValue: { currency: 'USD', amountMinor: -184000 },
    expectedRange: null,
    absoluteDelta: null,
    percentageDeltaBasisPoints: null,
    currency: 'USD',
    freshness: {
      state: 'fresh',
      sourceAsOf,
      maxAgeHours: 48,
      warningReason: null,
    },
    provenance: {
      connectorRef: connectorId,
      sourceGeneration: publicationId,
      bridgeContractVersion: 'bridge-v1',
      providerClass: 'monarchBridgeNormalized',
      sourceAsOf,
      coverageStart: '2026-08-01',
      coverageEnd: '2026-08-10',
      completeness: 'complete',
      detectorSetVersion: 'detectors-v1',
      detectorVersion: 'large-transaction-v1',
      methodVersion: 'threshold-v1',
      explanationTemplateVersion: 'large-transaction-v1',
      policyVersion: 1,
      evaluationStartedAt: '2026-08-10T12:01:00.000Z',
      evaluationCompletedAt: '2026-08-10T12:01:01.000Z',
    },
    targets: [{
      system: 'monarch',
      targetKind: 'transaction',
      sourceRef: 'transaction-one',
    }],
    createdAt: '2026-08-10T12:01:01.000Z',
    updatedAt: '2026-08-10T12:01:01.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

function completedEvaluation(sequence = 1) {
  return {
    contractVersion: '1.0' as const,
    identity: {
      householdScope: 'household-invented',
      connectorRef: connectorId,
      sourceGeneration: publicationId,
      detectorSetVersion: 'detectors-v1',
      policyVersion: 1,
    },
    sourceSequence: 1,
    evaluationSequence: sequence,
    acceptedAt: '2026-08-10T12:00:30.000Z',
    state: 'completed' as const,
    completedAt: '2026-08-10T12:01:01.000Z',
  };
}

function clientFor(
  items: InsightOccurrenceSummaryV1[],
  options: {
    failBatchOrdinal?: number;
    evaluationSequence?: number;
    evaluationState?: EvaluationResultV1['state'];
    sourceState?: 'staging' | 'historical';
  } = {},
) {
  let batchOrdinal = 0;
  return {
    createSourceGeneration: vi.fn(async (request: SourceGenerationCreateRequestV1) => {
      void request;
      return options.sourceState === 'historical'
        ? {
            contractVersion: '1.0' as const,
            connectorRef: connectorId,
            sourceGeneration: publicationId,
            sourceSequence: 1,
            state: 'historical' as const,
            detectorSetVersion: 'detectors-v1',
            policyVersion: 1,
          }
        : {
            contractVersion: '1.0' as const,
            connectorRef: connectorId,
            sourceGeneration: publicationId,
            sourceSequence: 1,
            state: 'staging' as const,
            detectorSetVersion: null,
            policyVersion: null,
          };
    }),
    putSourceFactBatch: vi.fn(async (batch: SourceFactBatchV1) => {
      const ordinal = batchOrdinal++;
      if (ordinal === options.failBatchOrdinal) {
        throw new Error('invented transport detail that must not persist');
      }
      return {
        contractVersion: '1.0' as const,
        sourceGeneration: batch.sourceGeneration,
        kind: batch.kind,
        batchIndex: batch.batchIndex,
        digest: batch.digest,
        state: 'accepted' as const,
      };
    }),
    commitSourceGeneration: vi.fn(async (request: SourceGenerationCommitRequestV1) => {
      void request;
      return {
        contractVersion: '1.0' as const,
        connectorRef: connectorId,
        sourceGeneration: publicationId,
        sourceSequence: 1,
        state: 'promoted' as const,
        detectorSetVersion: 'detectors-v1',
        policyVersion: 1,
      };
    }),
    retryEvaluation: vi.fn(async (
      request: EvaluationRequestV1,
    ): Promise<EvaluationResultV1> => {
      void request;
      const result = completedEvaluation(options.evaluationSequence);
      const state = options.evaluationState ?? 'completed';
      return state === 'queued' || state === 'evaluating'
        ? { ...result, state, completedAt: null }
        : { ...result, state };
    }),
    listOccurrences: vi.fn(async (
      query: OccurrenceListQueryV1,
    ): Promise<OccurrenceListResponseV1> => {
      void query;
      return {
        contractVersion: '1.0' as const,
        items,
        nextCursor: null,
      };
    }),
  };
}

function clearDatabase(): void {
  for (const table of [
    'notification_delivery_events',
    'notification_actions',
    'notifications',
    'tasks',
    'finance_insight_cutovers',
    'finance_insight_occurrences',
    'finance_insight_occurrence_cache_state',
    'finance_insight_publication_delivery',
    'finance_insight_publication_facts',
    'finance_insight_publication_state',
    'finance_insight_publications',
    'connector_configs',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
}

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED = 'true';
  vi.resetModules();
  ({ sqlite, runTransaction } = await import('@/db'));
  ({ createNotificationsInTransaction } = await import('@/lib/notifications/service'));
  ({ financeInsightDigestV1 } = await import('@/lib/finance-insights/canonical'));
  ({ sourceGenerationCreateRequestSchema } = await import('@/lib/finance-insights/contract'));
  ({ runFinanceInsightIngestion } = await import('@/lib/finance-insights/orchestrator'));
  ({ buildFinanceInsightNotificationInput } = await import(
    '@/lib/finance-insights/notification-ingestion'
  ));
  ({
    enableFinanceInsightCutover,
    rollbackFinanceInsightCutover,
    isLegacyFinanceAnomalyProductionEnabled,
  } = await import('@/lib/finance-insights/cutover'));
  ({
    buildFinanceMonthlyDigestInput,
    getFinanceMonthlyDigestSchedule,
    isMaterialRecurringIncrease,
    selectFinanceInsightNotificationInputs,
  } = await import('@/lib/finance-insights/notification-ingestion'));
  ({ syncFinanceProviderPresentation } = await import(
    '@/db/persistence/sqlite-finance-insight-notification-lifecycle'
  ));
});

beforeEach(clearDatabase);

afterAll(() => {
  delete process.env.MC_DB_PATH;
  delete process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('finance insight deterministic ingestion', () => {
  it('stores bounded merchant presentation metadata only for merchant movers', () => {
    const merchantKey = `merchant-v1_${'M'.repeat(43)}`;
    const merchantMover = occurrence({
      kind: 'merchantVariance',
      entity: {
        kind: 'merchant',
        sourceRef: merchantKey,
        displayName: 'Invented Merchant',
        identityQuality: 'normalizedName',
      },
    });
    const input = buildFinanceInsightNotificationInput(connectorId, merchantMover);
    expect(input).toMatchObject({
      category: 'finance',
      presentation: {
        financeMerchantKey: merchantKey,
        financeMerchantLabel: 'Invented Merchant',
      },
    });
    expect(input).not.toHaveProperty('relatedTaskId');
    expect(buildFinanceInsightNotificationInput(connectorId, occurrence()).presentation).toEqual({});
  });

  it('keeps variance movers status-only while preserving presentation metadata when explicitly built', () => {
    const merchantKey = `merchant-v1_${'M'.repeat(43)}`;
    const merchantMover = occurrence({
      kind: 'merchantVariance',
      entity: {
        kind: 'merchant',
        sourceRef: merchantKey,
        displayName: 'Invented Merchant',
        identityQuality: 'normalizedName',
      },
      targets: [{
        system: 'monarch',
        targetKind: 'reportFilter',
        reportKind: 'spending',
        period: { start: '2026-08-09', end: '2026-08-09' },
        categorySourceRef: null,
        merchantKey,
      }],
    });
    runTransaction((transaction) => {
      const inputs = selectFinanceInsightNotificationInputs(
        connectorId,
        [merchantMover],
        now,
        { environment: {} },
      );
      expect(inputs).toHaveLength(0);
      const created = createNotificationsInTransaction(
        transaction,
        [buildFinanceInsightNotificationInput(connectorId, merchantMover)],
        { now, wakeDispatcher: false },
      );
      syncFinanceProviderPresentation(transaction, created);
    });

    const stored = sqlite.prepare(`
      SELECT navigation_target AS navigationTarget, presentation
      FROM notifications
      WHERE source_id = ?
    `).get(`finance-insight:${connectorId}:${occurrenceId}`) as {
      navigationTarget: string;
      presentation: string;
    };
    expect(stored.navigationTarget).toBe(`/finance/insights/${occurrenceId}`);
    expect(JSON.parse(stored.presentation)).toMatchObject({
      financeMerchantKey: merchantKey,
      financeMerchantLabel: 'Invented Merchant',
      sourceName: 'Tyrion',
      providerSignature: 'finance-merchant-variance',
    });
    const navigateAction = sqlite.prepare(`
      SELECT payload
      FROM notification_actions
      WHERE action_type = 'navigate'
    `).get() as { payload: string };
    expect(JSON.parse(navigateAction.payload)).toEqual({
      target: `/finance/insights/${occurrenceId}`,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM notification_actions
      WHERE action_type = 'create_task'
    `).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM tasks`).get()).toEqual({ count: 0 });
  });

  it('keeps immediate large-transaction delivery default-off and fails closed', () => {
    const priorGate = process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED;
    delete process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED;
    try {
      const eligible = occurrence();
      expect(selectFinanceInsightNotificationInputs(
        connectorId,
        [eligible],
        now,
        { environment: {} },
      )).toEqual([]);
      expect(selectFinanceInsightNotificationInputs(
        connectorId,
        [occurrence({ confidence: 'medium', reasonCodes: [] })],
        now,
        {
          environment: {
            TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED: 'true',
          },
        },
      )).toHaveLength(1);
      for (const blocked of [
        occurrence({ confidence: 'low' }),
        occurrence({
          freshness: {
            state: 'stale',
            sourceAsOf,
            maxAgeHours: 48,
            warningReason: 'source_stale',
          },
        }),
        occurrence({
          freshness: {
            state: 'fresh',
            sourceAsOf: null,
            maxAgeHours: 48,
            warningReason: null,
          },
        }),
        occurrence({
          provenance: {
            ...occurrence().provenance,
            completeness: 'partial',
          },
        }),
        occurrence({ targets: [] }),
      ]) {
        expect(selectFinanceInsightNotificationInputs(
          connectorId,
          [blocked],
          now,
          {
            environment: {
              TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED: 'true',
            },
          },
        )).toEqual([]);
      }
      expect(selectFinanceInsightNotificationInputs(
        connectorId,
        [eligible],
        now,
        {
          environment: {
            TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED: '1',
          },
        },
      )).toEqual([]);
    } finally {
      if (priorGate === undefined) {
        delete process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED;
      } else {
        process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED = priorGate;
      }
    }
  });

  it('notifies only material recurring increases', () => {
    const recurring = occurrence({
      kind: 'recurringAmountChange',
      entity: {
        kind: 'recurring',
        sourceRef: 'recurring-one',
        displayName: 'Invented utility',
        identityQuality: 'stableSource',
      },
      reasonCodes: ['recurring_absolute_gate_exceeded'],
      percentageDeltaBasisPoints: 1250,
      absoluteDelta: { currency: 'USD', amountMinor: 2500 },
      targets: [{
        system: 'monarch',
        targetKind: 'recurring',
        sourceRef: 'recurring-one',
      }],
    });
    expect(isMaterialRecurringIncrease(recurring)).toBe(true);
    expect(selectFinanceInsightNotificationInputs(
      connectorId,
      [recurring],
      now,
      { environment: {} },
    )).toEqual([]);
    expect(selectFinanceInsightNotificationInputs(connectorId, [recurring], now, {
      environment: {
        TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED: 'true',
      },
    }))
      .toHaveLength(1);
    expect(isMaterialRecurringIncrease({
      ...recurring,
      percentageDeltaBasisPoints: -1250,
      reasonCodes: ['recurring_decrease_analysis_only'],
    })).toBe(false);
    expect(isMaterialRecurringIncrease({
      ...recurring,
      absoluteDelta: { currency: 'USD', amountMinor: 0 },
    })).toBe(false);
  });

  it('schedules one high-confidence top-10 monthly digest at household-local 09:00', () => {
    const before = getFinanceMonthlyDigestSchedule(
      new Date('2026-11-02T13:59:59.000Z'),
      'America/New_York',
    );
    const atSchedule = getFinanceMonthlyDigestSchedule(
      new Date('2026-11-02T14:00:00.000Z'),
      'America/New_York',
    );
    expect(before).toMatchObject({
      period: { start: '2026-10-01', end: '2026-10-31' },
      ready: false,
    });
    expect(atSchedule).toMatchObject({
      period: { start: '2026-10-01', end: '2026-10-31' },
      ready: true,
    });
    expect(atSchedule?.scheduledAt.toISOString()).toBe('2026-11-02T14:00:00.000Z');

    const movers = Array.from({ length: 13 }, (_, index) => occurrence({
      occurrenceId: `occurrence-invented-${String(index).padStart(2, '0')}`,
      deliveryRevision: index + 1,
      kind: index % 2 === 0 ? 'categoryVariance' : 'merchantVariance',
      entity: index % 2 === 0
        ? {
            kind: 'category',
            sourceRef: `category-${index}`,
            displayName: `Invented category ${index}`,
            identityQuality: 'stableSource',
          }
        : {
            kind: 'merchant',
            sourceRef: `merchant-v1_${'A'.repeat(42)}${index % 10}`,
            displayName: `Invented merchant ${index}`,
            identityQuality: 'normalizedName',
          },
      observationPeriod: { start: '2026-07-01', end: '2026-07-31' },
      freshness: {
        state: 'fresh',
        sourceAsOf: '2026-08-02T12:00:00.000Z',
        maxAgeHours: 48,
        warningReason: null,
      },
      provenance: {
        ...occurrence().provenance,
        sourceAsOf: '2026-08-02T12:00:00.000Z',
        evaluationCompletedAt: index === 12
          ? '2026-08-02T12:45:00.000Z'
          : '2026-08-02T12:01:01.000Z',
      },
      absoluteDelta: { currency: 'USD', amountMinor: (index + 1) * 1000 },
      percentageDeltaBasisPoints: (index + 1) * 100,
      targets: [{ system: 'monarch', targetKind: 'safeRoot', root: 'reports' }],
      createdAt: '2026-08-02T12:01:01.000Z',
      updatedAt: '2026-08-02T12:01:01.000Z',
    }));
    movers.push({
      ...movers[0]!,
      occurrenceId: 'occurrence-invented-medium',
      confidence: 'medium',
    });
    const digest = buildFinanceMonthlyDigestInput({
      connectorId,
      items: movers,
      now: new Date('2026-08-02T13:00:00.000Z'),
      timezone: 'America/New_York',
      environment: {
        TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED: 'true',
      },
    });
    expect(digest?.sourceId).toBe(
      `finance-insight-digest:${connectorId}:2026-07`,
    );
    expect(digest?.dedupeKey).toBe(digest?.sourceId);
    expect(digest?.groupKey).toBe(digest?.sourceId);
    expect(digest?.templateKey).toBe('finance-insight-monthly-movers-digest');
    expect(digest?.occurrenceKey).toMatch(/^2026-07:sha256:[a-f0-9]{64}$/);
    expect(digest?.sourceActivityAt).toBe('2026-08-02T12:45:00.000Z');
    expect(digest?.level).toBe('digest');
    expect((digest?.metadata?.movers as unknown[])).toHaveLength(10);
    expect(digest?.metadata?.moverCount).toBe(13);
    expect(JSON.stringify(digest)).not.toMatch(/fraud|suspicious/i);
    expect(buildFinanceMonthlyDigestInput({
      connectorId,
      items: movers,
      now: new Date('2026-08-02T12:59:59.000Z'),
      timezone: 'America/New_York',
      environment: {
        TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED: 'true',
      },
    })).toBeNull();
    expect(buildFinanceMonthlyDigestInput({
      connectorId,
      items: movers,
      now: new Date('2026-08-03T04:00:00.000Z'),
      timezone: 'America/New_York',
      environment: {
        TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED: 'true',
      },
    })).toBeNull();

    const revised = buildFinanceMonthlyDigestInput({
      connectorId,
      items: movers.map((item, index) => (
        index === 12 ? { ...item, deliveryRevision: item.deliveryRevision + 1 } : item
      )),
      now: new Date('2026-08-02T13:00:00.000Z'),
      timezone: 'America/New_York',
      environment: {
        TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED: 'true',
      },
    });
    expect(revised?.sourceId).toBe(digest?.sourceId);
    expect(revised?.occurrenceKey).not.toBe(digest?.occurrenceKey);

    const omittedMoverRevised = buildFinanceMonthlyDigestInput({
      connectorId,
      items: movers.map((item, index) => (
        index === 0
          ? {
              ...item,
              deliveryRevision: item.deliveryRevision + 1,
              updatedAt: '2026-08-02T12:50:00.000Z',
            }
          : item
      )),
      now: new Date('2026-08-02T13:00:00.000Z'),
      timezone: 'America/New_York',
      environment: {
        TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED: 'true',
      },
    });
    expect(omittedMoverRevised?.occurrenceKey).not.toBe(digest?.occurrenceKey);
    expect(omittedMoverRevised?.sourceActivityAt).toBe('2026-08-02T12:50:00.000Z');

    const reordered = buildFinanceMonthlyDigestInput({
      connectorId,
      items: [...movers].reverse(),
      now: new Date('2026-08-02T13:00:00.000Z'),
      timezone: 'America/New_York',
      environment: {
        TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED: 'true',
      },
    });
    expect(reordered?.occurrenceKey).toBe(digest?.occurrenceKey);

    const policyRevised = buildFinanceMonthlyDigestInput({
      connectorId,
      items: movers.map((item, index) => (
        index === 12
          ? {
              ...item,
              provenance: { ...item.provenance, policyVersion: 2 },
            }
          : item
      )),
      now: new Date('2026-08-02T13:00:00.000Z'),
      timezone: 'America/New_York',
      environment: {
        TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED: 'true',
      },
    });
    expect(policyRevised?.occurrenceKey).not.toBe(digest?.occurrenceKey);
  });

  it('selects exactly one enabled non-deleted Finance alias', async () => {
    const { getPersistedFinanceConnectorConfig } = await import(
      '@/lib/connectors/monarch-money/config'
    );
    await expect(getPersistedFinanceConnectorConfig()).rejects.toThrow(
      'Finance connector is not configured',
    );

    seedConnector('finance-primary', 'finance-manager');
    seedConnector('finance-disabled', 'monarch-money');
    sqlite.prepare(`
      UPDATE connector_configs SET enabled = 0 WHERE id = 'finance-disabled'
    `).run();
    seedConnector('finance-deleted', 'finance');
    sqlite.prepare(`
      UPDATE connector_configs SET deleted_at = ? WHERE id = 'finance-deleted'
    `).run(now.toISOString());
    seedConnector('unrelated-enabled', 'github-issues');

    await expect(getPersistedFinanceConnectorConfig()).resolves.toMatchObject({
      id: 'finance-primary',
      type: 'finance-manager',
      enabled: true,
    });

    seedConnector('finance-second', 'monarch-money');
    await expect(getPersistedFinanceConnectorConfig()).rejects.toThrow(
      'connectorId is required when multiple finance connectors are enabled',
    );
  });

  it('publishes all five batches, cuts over atomically, and dedupes replay and revision resurfacing', async () => {
    seedConnector();
    seedPublication();
    expect(() => enableFinanceInsightCutover({
      connectorId,
      sourceGeneration: publicationId,
      now,
    })).toThrow('finance_insight_cutover_generation_unavailable');
    const firstClient = clientFor([occurrence()]);
    const first = await runFinanceInsightIngestion({
      config: connector(),
      client: firstClient,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    });

    expect(first).toEqual({
      status: 'completed',
      itemCount: 1,
      notificationsProcessed: 0,
      notificationsAdded: 0,
    });
    expect(firstClient.putSourceFactBatch.mock.calls.map(([batch]) => batch.kind)).toEqual([
      'transaction',
      'recurring',
      'category',
      'account',
      'tag',
    ]);
    expect(firstClient.commitSourceGeneration).toHaveBeenCalledTimes(1);
    expect(firstClient.retryEvaluation.mock.calls[0][0].idempotencyKey)
      .toMatch(/^finance-evaluation-v1:/);
    expect(firstClient.retryEvaluation.mock.calls[0][0].idempotencyKey)
      .not.toBe(firstClient.createSourceGeneration.mock.calls[0][0].idempotencyKey);

    sqlite.prepare(`
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, level, category,
        template_key, state, read_state, disposition, source_state, sync_state,
        is_actionable, received_at, sort_at, metadata, presentation
      ) VALUES (
        'legacy-anomaly', 'legacy-anomaly', 'finance', 'finance-alerts',
        'Invented legacy anomaly', 'heads_up', 'finance', 'anomaly', 'unread',
        'unread', 'inbox', 'active', 'synced', 1, ?, ?, '{}', '{}'
      )
    `).run(now.toISOString(), now.toISOString());
    sqlite.prepare(`
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, level, category,
        template_key, state, read_state, disposition, source_state, sync_state,
        is_actionable, received_at, sort_at, metadata, presentation
      ) VALUES (
        'legacy-budget', 'legacy-budget', 'finance', 'finance-alerts',
        'Invented budget notice', 'heads_up', 'finance', 'budget_exceeded', 'unread',
        'unread', 'inbox', 'active', 'synced', 1, ?, ?, '{}', '{}'
      )
    `).run(now.toISOString(), now.toISOString());
    expect(isLegacyFinanceAnomalyProductionEnabled()).toBe(true);

    expect(enableFinanceInsightCutover({
      connectorId,
      sourceGeneration: publicationId,
      now,
    })).toEqual({ status: 'enabled', legacyExpiredCount: 1, importedCount: 1 });
    expect(enableFinanceInsightCutover({
      connectorId,
      sourceGeneration: publicationId,
      now,
    })).toEqual({ status: 'enabled', legacyExpiredCount: 1, importedCount: 1 });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState FROM notifications WHERE id = 'legacy-anomaly'
    `).get()).toEqual({ sourceState: 'resolved' });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState FROM notifications WHERE id = 'legacy-budget'
    `).get()).toEqual({ sourceState: 'active' });
    expect(isLegacyFinanceAnomalyProductionEnabled()).toBe(false);

    const sourceId = `finance-insight:${connectorId}:${occurrenceId}`;
    expect(sqlite.prepare(`
      SELECT connector_type AS connectorType, connector_instance_id AS connectorInstanceId,
             source_id AS sourceId, group_key AS groupKey, last_source_activity_key AS activityKey
      FROM notifications WHERE source_id = ?
    `).get(sourceId)).toEqual({
      connectorType: 'finance-manager',
      connectorInstanceId: connectorId,
      sourceId,
      groupKey: `finance-insight:${connectorId}:${insightId}`,
      activityKey: `${occurrenceId}:1`,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM notification_actions
    `).get()).toEqual({ count: 2 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM notification_actions WHERE action_type = 'create_task'
    `).get()).toEqual({ count: 0 });

    sqlite.prepare(`
      UPDATE notifications
      SET disposition = 'dismissed', read_state = 'read', state = 'dismissed',
          dismissed_at = ?
      WHERE source_id = ?
    `).run(now.toISOString(), sourceId);
    const revised = occurrence({
      deliveryRevision: 2,
      observedValue: { currency: 'USD', amountMinor: -194000 },
      updatedAt: '2026-08-10T12:03:00.000Z',
    });
    await runFinanceInsightIngestion({
      config: connector(),
      client: clientFor([revised]),
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count, disposition, last_source_activity_key AS activityKey
      FROM notifications WHERE source_id = ?
    `).get(sourceId)).toEqual({
      count: 1,
      disposition: 'inbox',
      activityKey: `${occurrenceId}:2`,
    });
    const deliveryCount = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM notification_delivery_events
      WHERE notification_id = (SELECT id FROM notifications WHERE source_id = ?)
    `).get(sourceId);
    await runFinanceInsightIngestion({
      config: connector(),
      client: clientFor([revised]),
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM notification_delivery_events
      WHERE notification_id = (SELECT id FROM notifications WHERE source_id = ?)
    `).get(sourceId)).toEqual(deliveryCount);

    const staleRevision = occurrence({
      deliveryRevision: 3,
      freshness: {
        state: 'stale',
        sourceAsOf,
        maxAgeHours: 48,
        warningReason: 'source_stale',
      },
      updatedAt: '2026-08-10T12:03:30.000Z',
    });
    await runFinanceInsightIngestion({
      config: connector(),
      client: clientFor([staleRevision]),
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState, is_actionable AS isActionable,
             source_resolved_at AS sourceResolvedAt
      FROM notifications WHERE source_id = ?
    `).get(sourceId)).toEqual({
      sourceState: 'resolved',
      isActionable: 0,
      sourceResolvedAt: now.toISOString(),
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM notification_actions
      WHERE notification_id = (SELECT id FROM notifications WHERE source_id = ?)
    `).get(sourceId)).toEqual({ count: 0 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM notification_delivery_events
      WHERE notification_id = (SELECT id FROM notifications WHERE source_id = ?)
    `).get(sourceId)).toEqual(deliveryCount);

    await runFinanceInsightIngestion({
      config: connector(),
      client: clientFor([{
        ...staleRevision,
        deliveryRevision: 4,
        updatedAt: '2026-08-10T12:03:40.000Z',
      }]),
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => new Date('2026-08-10T12:06:00.000Z'),
    });
    expect(sqlite.prepare(`
      SELECT source_resolved_at AS sourceResolvedAt
      FROM notifications WHERE source_id = ?
    `).get(sourceId)).toEqual({ sourceResolvedAt: now.toISOString() });

    const reeligible = occurrence({
      deliveryRevision: 5,
      observedValue: { currency: 'USD', amountMinor: -204000 },
      updatedAt: '2026-08-10T12:03:45.000Z',
    });
    await runFinanceInsightIngestion({
      config: connector(),
      client: clientFor([reeligible]),
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState, is_actionable AS isActionable
      FROM notifications WHERE source_id = ?
    `).get(sourceId)).toEqual({ sourceState: 'active', isActionable: 1 });

    const superseded = {
      ...reeligible,
      deliveryRevision: 6,
      sourceLifecycle: 'superseded' as const,
      resolutionReason: 'correction_superseded' as const,
      supersededByOccurrenceId: successorOccurrenceId,
      resolvedAt: '2026-08-10T12:04:00.000Z',
      updatedAt: '2026-08-10T12:04:00.000Z',
    };
    const successor = occurrence({
      occurrenceId: successorOccurrenceId,
      deliveryRevision: 1,
      observedValue: { currency: 'USD', amountMinor: -204000 },
      createdAt: '2026-08-10T12:04:00.000Z',
      updatedAt: '2026-08-10T12:04:00.000Z',
    });
    await runFinanceInsightIngestion({
      config: connector(),
      client: clientFor([superseded, successor]),
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM notifications
      WHERE group_key = ?
    `).get(`finance-insight:${connectorId}:${insightId}`)).toEqual({ count: 2 });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState FROM notifications WHERE source_id = ?
    `).get(sourceId)).toEqual({ sourceState: 'resolved' });

    sqlite.prepare(`
      UPDATE finance_insight_occurrence_cache_state
      SET source_generation = 'publication-newer', source_sequence = 2
      WHERE connector_id = ?
    `).run(connectorId);
    expect(enableFinanceInsightCutover({
      connectorId,
      sourceGeneration: publicationId,
      now,
    })).toEqual({ status: 'enabled', legacyExpiredCount: 1, importedCount: 1 });

    sqlite.prepare(`
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, level, category,
        template_key, state, read_state, disposition, source_state, sync_state,
        is_actionable, received_at, sort_at, metadata, presentation
      ) VALUES (
        'rollback-digest', ?, 'finance-manager', ?, 'Invented monthly movers',
        'digest', 'finance', 'finance-insight-monthly-movers-digest', 'unread',
        'unread', 'inbox', 'active', 'synced', 1, ?, ?, '{}', '{}'
      )
    `).run(
      `finance-insight-digest:${connectorId}:2026-07`,
      connectorId,
      now.toISOString(),
      now.toISOString(),
    );
    sqlite.prepare(`
      INSERT INTO notification_delivery_events (
        id, notification_id, channel, dedupe_key, status, policy_snapshot,
        payload_snapshot, attempt_count, lease_expires_at, created_at
      )
      SELECT 'rollback-in-flight', id, 'web_push', 'rollback-in-flight', 'sending',
             '{}', '{}', 1, ?, ?
      FROM notifications WHERE source_id = ?
    `).run('2026-08-10T12:06:00.000Z', now.toISOString(), sourceId);
    sqlite.prepare(`
      INSERT INTO notification_delivery_events (
        id, notification_id, channel, dedupe_key, status, policy_snapshot,
        payload_snapshot, attempt_count, lease_expires_at, created_at
      ) VALUES (
        'rollback-digest-in-flight', 'rollback-digest', 'web_push',
        'rollback-digest-in-flight', 'pending', '{}', '{}', 0, NULL, ?
      )
    `).run(now.toISOString());
    rollbackFinanceInsightCutover(connectorId, now);
    expect(sqlite.prepare(`
      SELECT legacy_disabled AS legacyDisabled, delivery_enabled AS deliveryEnabled
      FROM finance_insight_cutovers WHERE connector_id = ?
    `).get(connectorId)).toEqual({ legacyDisabled: 1, deliveryEnabled: 0 });
    expect(sqlite.prepare(`
      SELECT status, suppression_reason AS reason
      FROM notification_delivery_events
      WHERE id IN ('rollback-in-flight', 'rollback-digest-in-flight')
      ORDER BY id
    `).all()).toEqual([
      {
        status: 'suppressed',
        reason: 'finance_insight_cutover_rolled_back',
      },
      {
        status: 'suppressed',
        reason: 'finance_insight_cutover_rolled_back',
      },
    ]);

    sqlite.prepare(`
      UPDATE finance_insight_cutovers
      SET source_generation = 'publication-older',
          source_sequence = 0
      WHERE connector_id = ?
    `).run(connectorId);
    sqlite.prepare(`
      UPDATE finance_insight_occurrence_cache_state
      SET source_generation = ?, source_sequence = 1
      WHERE connector_id = ?
    `).run(publicationId, connectorId);
    sqlite.prepare(`
      UPDATE notifications
      SET source_state = 'active', state = 'unread',
          is_actionable = 1, source_resolved_at = NULL
      WHERE source_id = ?
    `).run(sourceId);

    expect(enableFinanceInsightCutover({
      connectorId,
      sourceGeneration: publicationId,
      now,
    })).toMatchObject({ status: 'enabled' });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState, state, is_actionable AS isActionable
      FROM notifications WHERE source_id = ?
    `).get(sourceId)).toEqual({
      sourceState: 'resolved',
      state: 'resolved',
      isActionable: 0,
    });

    expect(isLegacyFinanceAnomalyProductionEnabled()).toBe(false);
    seedConnector('finance-invented-second');
    expect(isLegacyFinanceAnomalyProductionEnabled()).toBe(false);
  });

  it('resumes at the exact crash batch and classifies conflicts and stale fences', async () => {
    seedConnector();
    seedPublication();
    const crashingClient = clientFor([occurrence()], { failBatchOrdinal: 2 });
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client: crashingClient,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({
      status: 'failed',
      code: 'finance_insight_ingestion_failed',
      retryable: true,
    });
    expect(sqlite.prepare(`
      SELECT next_batch_ordinal AS ordinal, last_error_code AS code
      FROM finance_insight_publication_delivery WHERE publication_id = ?
    `).get(publicationId)).toEqual({
      ordinal: 2,
      code: 'finance_insight_ingestion_failed',
    });

    const resumedClient = clientFor([occurrence()]);
    expect((await runFinanceInsightIngestion({
      config: connector(),
      client: resumedClient,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).status).toBe('completed');
    expect(resumedClient.putSourceFactBatch.mock.calls.map(([batch]) => batch.kind)).toEqual([
      'category',
      'account',
      'tag',
    ]);

    const historical = clientFor([occurrence()], { sourceState: 'historical' });
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client: historical,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({
      status: 'failed',
      code: 'stale_source_generation',
      retryable: false,
    });

    sqlite.prepare(`
      UPDATE finance_insight_publication_delivery SET evaluation_sequence = 7
      WHERE publication_id = ?
    `).run(publicationId);
    const staleEvaluation = clientFor([occurrence()], { evaluationSequence: 6 });
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client: staleEvaluation,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({
      status: 'failed',
      code: 'stale_evaluation',
      retryable: false,
    });
    expect(JSON.stringify(sqlite.prepare(`
      SELECT last_error_code AS code FROM finance_insight_publication_delivery
      WHERE publication_id = ?
    `).get(publicationId))).not.toContain('invented transport detail');
  });

  it.each([
    ['failed', 'finance_insight_evaluation_failed', false],
    ['unavailable', 'finance_insight_evaluation_unavailable', true],
  ] as const)('records terminal %s evaluations as failures', async (state, code, retryable) => {
    seedConnector();
    seedPublication();

    expect(await runFinanceInsightIngestion({
      config: connector(),
      client: clientFor([], { evaluationState: state }),
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({ status: 'failed', code, retryable });
    expect(sqlite.prepare(`
      SELECT evaluation_state AS evaluationState,
             last_error_code AS errorCode,
             last_error_retryable AS errorRetryable
      FROM finance_insight_publication_delivery
      WHERE publication_id = ?
    `).get(publicationId)).toEqual({
      evaluationState: state,
      errorCode: code,
      errorRetryable: retryable ? 1 : 0,
    });
  });

  it('binds pagination filters and rejects an over-limit snapshot without partial replacement', async () => {
    seedConnector();
    seedPublication();
    const first = occurrence();
    const second = occurrence({
      occurrenceId: successorOccurrenceId,
      entity: {
        ...occurrence().entity,
        sourceRef: 'transaction-two',
      },
    });
    const pagedClient = clientFor([]);
    pagedClient.listOccurrences
      .mockResolvedValueOnce({
        contractVersion: '1.0',
        items: [first],
        nextCursor: 'opaque-cursor',
      })
      .mockResolvedValueOnce({
        contractVersion: '1.0',
        items: [second],
        nextCursor: null,
      });
    expect((await runFinanceInsightIngestion({
      config: connector(),
      client: pagedClient,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).status).toBe('completed');
    const [firstQuery] = pagedClient.listOccurrences.mock.calls[0];
    const [secondQuery] = pagedClient.listOccurrences.mock.calls[1];
    expect({ ...secondQuery, cursor: null }).toEqual(firstQuery);
    expect(secondQuery.cursor).toBe('opaque-cursor');
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_occurrences WHERE connector_id = ?
    `).get(connectorId)).toEqual({ count: 2 });

    const overLimitClient = clientFor([]);
    overLimitClient.listOccurrences.mockImplementation(async (query) => {
      const page = query.cursor === null ? 0 : Number(query.cursor);
      return {
        contractVersion: '1.0' as const,
        items: Array.from({ length: 100 }, (_, index) => occurrence({
          occurrenceId: `occurrence-v1_${String(page * 100 + index).padStart(43, 'D')}`,
          entity: {
            ...occurrence().entity,
            sourceRef: `transaction-${page}-${index}`,
          },
        })),
        nextCursor: page === 5 ? null : String(page + 1),
      };
    });
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client: overLimitClient,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({
      status: 'failed',
      code: 'page_too_large',
      retryable: false,
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_occurrences WHERE connector_id = ?
    `).get(connectorId)).toEqual({ count: 2 });

    const tooManyPagesClient = clientFor([]);
    tooManyPagesClient.listOccurrences.mockImplementation(async (query) => ({
      contractVersion: '1.0' as const,
      items: [],
      nextCursor: String(query.cursor === null ? 1 : Number(query.cursor) + 1),
    }));
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client: tooManyPagesClient,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({
      status: 'failed',
      code: 'page_too_large',
      retryable: false,
    });
    expect(tooManyPagesClient.listOccurrences).toHaveBeenCalledTimes(10);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_occurrences WHERE connector_id = ?
    `).get(connectorId)).toEqual({ count: 2 });

    const mismatchedEvaluation = occurrence({
      provenance: {
        ...occurrence().provenance,
        detectorSetVersion: 'detectors-v2',
      },
    });
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client: clientFor([mismatchedEvaluation]),
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({
      status: 'failed',
      code: 'stale_evaluation',
      retryable: false,
    });
  });

  it('defaults shadow off and fails closed for zero or multiple configured connectors', async () => {
    seedConnector();
    seedPublication();
    const client = clientFor([occurrence()]);
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client,
      environment: {},
      clock: () => now,
    })).toEqual({ status: 'disabled' });
    expect(client.createSourceGeneration).not.toHaveBeenCalled();

    sqlite.exec(`DELETE FROM connector_configs`);
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({
      status: 'failed',
      code: 'finance_insight_connector_unavailable',
      retryable: false,
    });
    seedConnector();
    seedConnector('finance-second', 'monarch-money');
    expect(await runFinanceInsightIngestion({
      config: connector(),
      client,
      environment: { TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true' },
      clock: () => now,
    })).toEqual({
      status: 'failed',
      code: 'finance_insight_connector_unavailable',
      retryable: false,
    });
  });
});
