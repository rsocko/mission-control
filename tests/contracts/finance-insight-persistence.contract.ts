import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import { financeInsightOccurrenceRevisionDigest } from '@/lib/finance-insights/occurrence-shared';
import type {
  FinanceInsightBackfillTransaction,
  FinanceInsightOccurrenceReplaceItem,
  FinanceInsightPersistence,
  FinanceInsightWindowProof,
} from '@/db/persistence/finance-insights';

// A schema-valid InsightOccurrenceSummaryV1, reused (with detail-only fields
// stripped) from the same fixture tests/connectors/tyrion-finance-insight-client.test.ts
// relies on, so the legacy-digest-fallback tests below can call the real
// financeInsightOccurrenceRevisionDigest() helper without hand-maintaining the
// summary schema's many cross-field constraints.
function legacySummaryPayloadFixture(): Record<string, unknown> {
  const detail = JSON.parse(readFileSync(
    resolve(process.cwd(), 'tests/fixtures/finance-insights/occurrence-detail.json'),
    'utf8',
  )) as Record<string, unknown>;
  for (const detailField of [
    'ruleResults', 'baseline', 'comparisons', 'contributors', 'exclusions', 'evidence',
    'lifecycleHistory', 'suppression', 'availableActions',
  ]) {
    delete detail[detailField];
  }
  return detail;
}

export const CONNECTOR_ID = 'finance-insight-contract';
export const CONNECTOR_ID_SECOND = 'finance-insight-contract-second';
export const BASE_TIME = '2026-09-01T00:00:00.000Z';
export const IDENTITY_NAMESPACE = 'a'.repeat(64);

export interface FinanceInsightDeliveryRow {
  stage: string;
  nextBatchOrdinal: number;
  detectorSetVersion: string | null;
  policyVersion: number | null;
  evaluationSequence: number | null;
  evaluationState: string | null;
  lastErrorCode: string | null;
  lastErrorRetryable: boolean;
}

export interface FinanceInsightOccurrenceRow {
  isTombstone: boolean;
  sourceLifecycle: string | null;
  sourceGeneration: string;
  sourceSequence: number;
  deliveryRevision: number;
  revisionDigest: string;
  entityLabel: string;
  headline: string;
  targetDescriptors: unknown;
  summaryPayload: unknown;
  sourceUpdatedAt: string;
  cachedAt: string;
}

export interface FinanceInsightLegacyOccurrenceInput {
  connectorId: string;
  occurrenceId: string;
  sourceGeneration: string;
  sourceSequence: number;
  isTombstone: boolean;
  sourceLifecycle: string | null;
  deliveryRevision: number;
  revisionDigest: string;
  summaryPayload: unknown;
  sourceUpdatedAt: string;
  cachedAt: string;
}

/** Both adapter factories omit the `notifications` sub-port; it is composed elsewhere. */
export type FinanceInsightContractRepositories = Omit<FinanceInsightPersistence, 'notifications'>;

export interface FinanceInsightContractHarness {
  repositories: FinanceInsightContractRepositories;
  reset(): Promise<void>;
  seedConnector(overrides?: {
    id?: string;
    type?: string;
    enabled?: boolean;
    deletedAt?: string | null;
    identityNamespace?: string | null;
  }): Promise<void>;
  setDeliveryEnabled(connectorId: string, enabled: boolean): Promise<void>;
  setProjectionCurrentAttempt(connectorId: string, attemptId: string | null): Promise<void>;
  deliveryRow(publicationId: string): Promise<FinanceInsightDeliveryRow | null>;
  occurrenceRow(connectorId: string, occurrenceId: string): Promise<FinanceInsightOccurrenceRow | null>;
  occurrenceRowCount(connectorId: string): Promise<number>;
  insertLegacyOccurrenceRow(input: FinanceInsightLegacyOccurrenceInput): Promise<void>;
}

// ─── Fixture builders ───────────────────────────────────────────────────────

function backfillTransaction(
  id: string,
  date: string,
  overrides: Partial<FinanceInsightBackfillTransaction> = {},
): FinanceInsightBackfillTransaction {
  return {
    id,
    date,
    amount: -10,
    merchant: { name: `Merchant ${id}`, logoUrl: null },
    category: null,
    account: { id: 'account-one', displayName: 'Checking', mask: '1234' },
    isPending: false,
    isRecurring: false,
    notes: null,
    tags: [],
    tagReferences: [],
    ...overrides,
  };
}

interface TransactionFact {
  sourceRef: string;
  occurredOn: string;
  amountMinor: number;
  merchantName: string;
  categoryRef: string | null;
  accountRef: string | null;
  isPending: boolean;
  recurringRef: string | null;
  tagRefs: string[];
}

function transactionFact(
  sourceRef: string,
  occurredOn: string,
  overrides: Partial<TransactionFact> = {},
): TransactionFact {
  return {
    sourceRef,
    occurredOn,
    amountMinor: -500,
    merchantName: 'Coffee shop',
    categoryRef: null,
    accountRef: null,
    isPending: false,
    recurringRef: null,
    tagRefs: [],
    ...overrides,
  };
}

function windowProof(overrides: Partial<FinanceInsightWindowProof> = {}): FinanceInsightWindowProof {
  return {
    index: 0,
    start: '2026-08-01',
    end: '2026-08-31',
    sourceAsOf: BASE_TIME,
    itemCount: 1,
    digest: 'window-digest',
    ...overrides,
  };
}

/**
 * `finance_insight_publication_delivery` has an FK to `finance_insight_publications`,
 * so delivery-checkpoint tests must first capture a real publication row for
 * each `publicationId`/`sourceSequence` pair they exercise.
 */
async function capturePublicationForDelivery(
  repositories: FinanceInsightContractRepositories,
  connectorId: string,
  publicationId: string,
  sourceSequence: number,
  generationIdentity: string,
): Promise<void> {
  await repositories.publication.capture({
    connectorId,
    providerType: 'monarch-money',
    capturedAt: BASE_TIME,
    generationIdentity,
    expectedSourceSequence: sourceSequence,
    publicationId,
    idempotencyKey: `idempotency-${publicationId}`,
    createRequest: {},
    contractVersion: '1.0',
    sourceAsOf: BASE_TIME,
    coverageStart: '2026-08-01',
    coverageEnd: '2026-08-31',
    currency: 'USD',
    bridgeContractVersion: '1.0',
    capturedConstituents: {},
    manifest: {},
    manifestDigest: `manifest-${publicationId}`,
    expiresAt: '2026-09-08T00:00:00.000Z',
    cacheCount: 5,
    facts: [],
  });
}

function occurrenceItem(
  occurrenceId: string,
  overrides: Partial<FinanceInsightOccurrenceReplaceItem> = {},
): FinanceInsightOccurrenceReplaceItem {
  return {
    occurrenceId,
    insightId: 'insight-one',
    deliveryRevision: 1,
    revisionDigest: 'digest-one',
    kind: 'transaction-anomaly',
    entityKind: 'transaction',
    entitySourceRef: 'transaction-v1:example',
    entityLabel: 'Example entity',
    analysisState: 'complete',
    sourceLifecycle: 'open',
    severity: 'medium',
    confidence: 'high',
    baselineSufficiency: 'sufficient',
    headline: 'Example headline',
    freshnessState: 'fresh',
    freshnessSourceAsOf: BASE_TIME,
    targetDescriptors: [],
    summaryPayload: { note: 'example' },
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

// ─── Contract ────────────────────────────────────────────────────────────────

export function describeFinanceInsightPersistenceContract(
  label: string,
  createHarness: () => Promise<FinanceInsightContractHarness>,
): void {
  describe(`${label} finance insight persistence contract`, () => {
    let harness: FinanceInsightContractHarness;

    beforeEach(async () => {
      harness ??= await createHarness();
      await harness.reset();
      await harness.seedConnector();
    });

    describe('connector selection', () => {
      it('resolves the single enabled, non-deleted connector of the given types and null otherwise', async () => {
        const { connectors } = harness.repositories;
        await expect(connectors.listEnabledConnectorIds(['finance-manager'], 2))
          .resolves.toEqual([CONNECTOR_ID]);
        await expect(connectors.resolveSingleEnabledConnectorId(['finance-manager']))
          .resolves.toBe(CONNECTOR_ID);
        await expect(connectors.resolveSingleEnabledConnectorId([])).resolves.toBeNull();
        await expect(connectors.resolveSingleEnabledConnectorId(['some-other-type']))
          .resolves.toBeNull();

        await harness.seedConnector({ id: CONNECTOR_ID_SECOND });
        await expect(connectors.listEnabledConnectorIds(['finance-manager'], 2))
          .resolves.toEqual([CONNECTOR_ID, CONNECTOR_ID_SECOND]);
        await expect(connectors.resolveSingleEnabledConnectorId(['finance-manager']))
          .resolves.toBeNull();

        await harness.reset();
        await harness.seedConnector({ deletedAt: BASE_TIME });
        await expect(connectors.resolveSingleEnabledConnectorId(['finance-manager']))
          .resolves.toBeNull();

        await harness.reset();
        await harness.seedConnector({ enabled: false });
        await expect(connectors.resolveSingleEnabledConnectorId(['finance-manager']))
          .resolves.toBeNull();
      });
    });

    describe('history projection', () => {
      it('stages and promotes a projection attempt, exposing the promoted generation', async () => {
        const { projection } = harness.repositories;
        await projection.startAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-1',
          attemptAt: BASE_TIME,
        });
        const fact = transactionFact('transaction-a', '2026-08-01');
        await projection.insertAttemptFacts({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-1',
          facts: [{ sourceRef: fact.sourceRef, occurredOn: fact.occurredOn, payload: fact }],
        });
        const proof = windowProof({
          digest: financeInsightDigestV1([fact] as unknown as CanonicalJsonValue),
        });
        await projection.insertAttemptWindowProof({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-1',
          proof,
        });

        await projection.promoteAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-1',
          generationId: 'generation-1',
          completedAt: BASE_TIME,
          sourceAsOf: BASE_TIME,
          itemCount: 1,
          contentDigest: financeInsightDigestV1([fact] as unknown as CanonicalJsonValue),
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          windowCount: 1,
          windowsDigest: financeInsightDigestV1([proof] as unknown as CanonicalJsonValue),
          bridgeContractVersion: '1.0',
        });

        await expect(projection.readState(CONNECTOR_ID)).resolves.toMatchObject({
          status: 'succeeded',
          generationId: 'generation-1',
          itemCount: 1,
        });
        await expect(projection.readPromotedTransactionFacts(CONNECTOR_ID, 'generation-1'))
          .resolves.toEqual([fact]);
        await expect(projection.readWindowProofs(CONNECTOR_ID, 'generation-1'))
          .resolves.toEqual([proof]);
        await expect(projection.readAttemptFacts(CONNECTOR_ID, 'attempt-1')).resolves.toEqual([]);
      });

      it('fences a stale promoteAttempt and rolls back without losing staged data or clobbering current state', async () => {
        const { projection } = harness.repositories;
        await projection.startAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-fenced',
          attemptAt: BASE_TIME,
        });
        const fact = transactionFact('transaction-a', '2026-08-01');
        await projection.insertAttemptFacts({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-fenced',
          facts: [{ sourceRef: fact.sourceRef, occurredOn: fact.occurredOn, payload: fact }],
        });
        const proof = windowProof({
          digest: financeInsightDigestV1([fact] as unknown as CanonicalJsonValue),
        });
        await projection.insertAttemptWindowProof({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-fenced',
          proof,
        });
        // Simulate a concurrent process superseding the current attempt pointer
        // without touching the staged facts/windows, so the fence check (not
        // the staged-content drift check) is what rejects the stale promote.
        await harness.setProjectionCurrentAttempt(CONNECTOR_ID, 'someone-elses-attempt');

        await expect(projection.promoteAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-fenced',
          generationId: 'generation-fenced',
          completedAt: BASE_TIME,
          sourceAsOf: BASE_TIME,
          itemCount: 1,
          contentDigest: financeInsightDigestV1([fact] as unknown as CanonicalJsonValue),
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          windowCount: 1,
          windowsDigest: financeInsightDigestV1([proof] as unknown as CanonicalJsonValue),
          bridgeContractVersion: '1.0',
        })).rejects.toMatchObject({ name: 'FinanceInsightProjectionFenceError' });

        // Rollback: staged rows survive, and current state was not clobbered.
        await expect(projection.readAttemptFacts(CONNECTOR_ID, 'attempt-fenced'))
          .resolves.toEqual([{ sourceRef: fact.sourceRef, occurredOn: fact.occurredOn, payload: fact }]);
        await expect(projection.readState(CONNECTOR_ID)).resolves.toMatchObject({
          status: 'running',
          generationId: null,
        });
      });

      it('clears an abandoned attempt on the next startAttempt while preserving the last-promoted generation', async () => {
        const { projection } = harness.repositories;
        await projection.startAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-a',
          attemptAt: BASE_TIME,
        });
        const fact = transactionFact('transaction-a', '2026-08-01');
        await projection.insertAttemptFacts({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-a',
          facts: [{ sourceRef: fact.sourceRef, occurredOn: fact.occurredOn, payload: fact }],
        });
        const proof = windowProof({
          digest: financeInsightDigestV1([fact] as unknown as CanonicalJsonValue),
        });
        await projection.insertAttemptWindowProof({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-a',
          proof,
        });
        await projection.promoteAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-a',
          generationId: 'generation-a',
          completedAt: BASE_TIME,
          sourceAsOf: BASE_TIME,
          itemCount: 1,
          contentDigest: financeInsightDigestV1([fact] as unknown as CanonicalJsonValue),
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          windowCount: 1,
          windowsDigest: financeInsightDigestV1([proof] as unknown as CanonicalJsonValue),
          bridgeContractVersion: '1.0',
        });

        // A second attempt starts and stages facts, but is abandoned (never promoted).
        await projection.startAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-b',
          attemptAt: '2026-09-01T00:01:00.000Z',
        });
        await projection.insertAttemptFacts({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-b',
          facts: [{ sourceRef: 'transaction-b', occurredOn: '2026-08-05', payload: {} }],
        });

        // A third attempt starts; its cleanup must wipe attempt-b's abandoned
        // staged rows while leaving generation-a's promoted rows untouched.
        await projection.startAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-c',
          attemptAt: '2026-09-01T00:02:00.000Z',
        });

        await expect(projection.readAttemptFacts(CONNECTOR_ID, 'attempt-b')).resolves.toEqual([]);
        await expect(projection.readPromotedTransactionFacts(CONNECTOR_ID, 'generation-a'))
          .resolves.toEqual([fact]);
        await expect(projection.readState(CONNECTOR_ID)).resolves.toMatchObject({
          status: 'running',
          generationId: 'generation-a',
        });
      });

      it('validates staged fact/window counts and digests atomically, rolling back without partial mutation on either mismatch, and no-ops failAttempt for a superseded attempt', async () => {
        const { projection } = harness.repositories;
        await projection.startAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-drift',
          attemptAt: BASE_TIME,
        });
        const fact = transactionFact('transaction-a', '2026-08-01');
        await projection.insertAttemptFacts({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-drift',
          facts: [{ sourceRef: fact.sourceRef, occurredOn: fact.occurredOn, payload: fact }],
        });
        const proof = windowProof({
          digest: financeInsightDigestV1([fact] as unknown as CanonicalJsonValue),
        });
        await projection.insertAttemptWindowProof({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-drift',
          proof,
        });
        const correctContentDigest = financeInsightDigestV1(
          [fact] as unknown as CanonicalJsonValue,
        );
        const correctWindowsDigest = financeInsightDigestV1([proof] as unknown as CanonicalJsonValue);

        await expect(projection.promoteAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-drift',
          generationId: 'generation-drift',
          completedAt: BASE_TIME,
          sourceAsOf: BASE_TIME,
          itemCount: 2, // declared fact count drifts from the single staged fact
          contentDigest: correctContentDigest,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          windowCount: 1,
          windowsDigest: correctWindowsDigest,
          bridgeContractVersion: '1.0',
        })).rejects.toThrow('finance_insight_history_changed_before_commit');

        // Atomic rollback: the staged rows are untouched (still readable under
        // the original attemptId, never renamed to the generationId) and the
        // projection state was never flipped to succeeded.
        await expect(projection.readAttemptFacts(CONNECTOR_ID, 'attempt-drift'))
          .resolves.toEqual([{ sourceRef: fact.sourceRef, occurredOn: fact.occurredOn, payload: fact }]);
        await expect(projection.readWindowProofs(CONNECTOR_ID, 'attempt-drift')).resolves.toEqual([proof]);
        await expect(projection.readState(CONNECTOR_ID)).resolves.toMatchObject({
          status: 'running',
          generationId: null,
        });

        // A declared window count/digest that drifts from the staged window
        // proof is validated too, even when the fact side is fully correct.
        await expect(projection.promoteAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-drift',
          generationId: 'generation-drift',
          completedAt: BASE_TIME,
          sourceAsOf: BASE_TIME,
          itemCount: 1,
          contentDigest: correctContentDigest,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          windowCount: 1,
          windowsDigest: 'wrong-windows-digest',
          bridgeContractVersion: '1.0',
        })).rejects.toThrow('finance_insight_history_changed_before_commit');

        // Same atomic-rollback guarantee applies to the window-side mismatch.
        await expect(projection.readAttemptFacts(CONNECTOR_ID, 'attempt-drift'))
          .resolves.toEqual([{ sourceRef: fact.sourceRef, occurredOn: fact.occurredOn, payload: fact }]);
        await expect(projection.readWindowProofs(CONNECTOR_ID, 'attempt-drift')).resolves.toEqual([proof]);
        await expect(projection.readState(CONNECTOR_ID)).resolves.toMatchObject({
          status: 'running',
          generationId: null,
        });

        // failAttempt is fenced too: the still-current attempt records, a
        // superseded/nonexistent one is a tolerant no-op.
        await expect(projection.failAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'someone-elses-attempt',
          failedAt: BASE_TIME,
          errorCode: 'stale',
        })).resolves.toEqual({ recorded: false });
        await expect(projection.failAttempt({
          connectorId: CONNECTOR_ID,
          attemptId: 'attempt-drift',
          failedAt: BASE_TIME,
          errorCode: 'boom',
        })).resolves.toEqual({ recorded: true });
        await expect(projection.readState(CONNECTOR_ID)).resolves.toMatchObject({
          status: 'failed',
          generationId: null,
        });
      });
    });

    describe('transaction backfill', () => {
      it('fences backfill writes while delivery is enabled for the connector', async () => {
        const { backfill } = harness.repositories;
        await harness.setDeliveryEnabled(CONNECTOR_ID, true);

        await expect(backfill.assertDeliveryDisabled(CONNECTOR_ID))
          .rejects.toMatchObject({ name: 'FinanceInsightBackfillDeliveryEnabledError' });
        await expect(backfill.createPlan({
          connectorId: CONNECTOR_ID,
          idempotencyKey: 'plan-fenced',
          horizonMonths: 1,
          currency: 'USD',
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          bridgeContractVersion: '1.0',
          windowCount: 1,
          now: BASE_TIME,
        })).rejects.toMatchObject({ name: 'FinanceInsightBackfillDeliveryEnabledError' });
      });

      it('returns the same plan idempotently for a repeated idempotency key, ignoring later parameter drift', async () => {
        const { backfill } = harness.repositories;
        const first = await backfill.createPlan({
          connectorId: CONNECTOR_ID,
          idempotencyKey: 'plan-idempotent',
          horizonMonths: 3,
          currency: 'USD',
          coverageStart: '2026-06-01',
          coverageEnd: '2026-08-31',
          bridgeContractVersion: '1.0',
          windowCount: 3,
          now: BASE_TIME,
        });
        const second = await backfill.createPlan({
          connectorId: CONNECTOR_ID,
          idempotencyKey: 'plan-idempotent',
          horizonMonths: 99, // drift; must be ignored
          currency: 'EUR',
          coverageStart: '2020-01-01',
          coverageEnd: '2020-01-31',
          bridgeContractVersion: '2.0',
          windowCount: 1,
          now: '2026-09-02T00:00:00.000Z',
        });
        expect(second).toEqual(first);
        expect(first.horizonMonths).toBe(3);
      });

      it('advances a plan window-by-window to completion, and fences an oversized or incomplete window', async () => {
        const { backfill } = harness.repositories;
        const plan = await backfill.createPlan({
          connectorId: CONNECTOR_ID,
          idempotencyKey: 'plan-windows',
          horizonMonths: 2,
          currency: 'USD',
          coverageStart: '2026-07-01',
          coverageEnd: '2026-08-31',
          bridgeContractVersion: '1.0',
          windowCount: 2,
          now: BASE_TIME,
        });

        await backfill.upsertTransactionPage({
          connectorId: CONNECTOR_ID,
          generationRef: 'window-0',
          transactions: [backfillTransaction('txn-window-0', '2026-07-15')],
          provenance: { provider: 'live', fetchedAt: BASE_TIME },
          now: BASE_TIME,
        });

        // Wrong declared count for the live window: incomplete.
        await expect(backfill.recordWindowCapture({
          connectorId: CONNECTOR_ID,
          planId: plan.id,
          windowOrdinal: 0,
          planWindowCount: 2,
          windowStart: '2026-07-01',
          windowEnd: '2026-07-31',
          generationRef: 'window-0',
          sourceAsOf: BASE_TIME,
          currency: 'USD',
          bridgeContractVersion: '1.0',
          completedAt: BASE_TIME,
          expectedItemCount: 2,
          maxTotalItemCount: 500,
        })).rejects.toMatchObject({ name: 'FinanceInsightBackfillWindowIncompleteError' });

        // Correct count, but a ceiling far below it: too large.
        await expect(backfill.recordWindowCapture({
          connectorId: CONNECTOR_ID,
          planId: plan.id,
          windowOrdinal: 0,
          planWindowCount: 2,
          windowStart: '2026-07-01',
          windowEnd: '2026-07-31',
          generationRef: 'window-0',
          sourceAsOf: BASE_TIME,
          currency: 'USD',
          bridgeContractVersion: '1.0',
          completedAt: BASE_TIME,
          expectedItemCount: 1,
          maxTotalItemCount: 0,
        })).rejects.toMatchObject({ name: 'FinanceInsightBackfillTooLargeError' });

        const window0 = await backfill.recordWindowCapture({
          connectorId: CONNECTOR_ID,
          planId: plan.id,
          windowOrdinal: 0,
          planWindowCount: 2,
          windowStart: '2026-07-01',
          windowEnd: '2026-07-31',
          generationRef: 'window-0',
          sourceAsOf: BASE_TIME,
          currency: 'USD',
          bridgeContractVersion: '1.0',
          completedAt: BASE_TIME,
          expectedItemCount: 1,
          maxTotalItemCount: 500,
        });
        expect(window0).toEqual({ itemCount: 1 });
        await expect(backfill.loadPlan(CONNECTOR_ID, 'plan-windows'))
          .resolves.toMatchObject({ status: 'running', nextWindowOrdinal: 1 });

        await backfill.upsertTransactionPage({
          connectorId: CONNECTOR_ID,
          generationRef: 'window-1',
          transactions: [backfillTransaction('txn-window-1', '2026-08-15')],
          provenance: { provider: 'live', fetchedAt: BASE_TIME },
          now: BASE_TIME,
        });
        await backfill.recordWindowCapture({
          connectorId: CONNECTOR_ID,
          planId: plan.id,
          windowOrdinal: 1,
          planWindowCount: 2,
          windowStart: '2026-08-01',
          windowEnd: '2026-08-31',
          generationRef: 'window-1',
          sourceAsOf: BASE_TIME,
          currency: 'USD',
          bridgeContractVersion: '1.0',
          completedAt: BASE_TIME,
          expectedItemCount: 1,
          maxTotalItemCount: 500,
        });

        await expect(backfill.loadPlan(CONNECTOR_ID, 'plan-windows'))
          .resolves.toMatchObject({ status: 'completed', nextWindowOrdinal: 2 });
        await expect(backfill.loadWindowProofs(plan.id)).resolves.toHaveLength(2);
      });

      it('promotes a completed plan idempotently, and conflicts (not silently overwrites) when a different generation is already current', async () => {
        const { backfill, projection } = harness.repositories;
        const plan = await backfill.createPlan({
          connectorId: CONNECTOR_ID,
          idempotencyKey: 'plan-promote',
          horizonMonths: 1,
          currency: 'USD',
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          bridgeContractVersion: '1.0',
          windowCount: 1,
          now: BASE_TIME,
        });
        await backfill.upsertTransactionPage({
          connectorId: CONNECTOR_ID,
          generationRef: 'window-promote',
          transactions: [backfillTransaction('txn-promote', '2026-08-15')],
          provenance: { provider: 'live', fetchedAt: BASE_TIME },
          now: BASE_TIME,
        });
        await backfill.recordWindowCapture({
          connectorId: CONNECTOR_ID,
          planId: plan.id,
          windowOrdinal: 0,
          planWindowCount: 1,
          windowStart: '2026-08-01',
          windowEnd: '2026-08-31',
          generationRef: 'window-promote',
          sourceAsOf: BASE_TIME,
          currency: 'USD',
          bridgeContractVersion: '1.0',
          completedAt: BASE_TIME,
          expectedItemCount: 1,
          maxTotalItemCount: 500,
        });

        const facts = [{ sourceRef: 'transaction-promote', occurredOn: '2026-08-15', amountMinor: -100 }];
        const windows = [windowProof({ digest: 'promote-window-digest' })];
        const promotionInput = {
          connectorId: CONNECTOR_ID,
          planId: plan.id,
          idempotencyKey: 'plan-promote',
          sourceAsOf: BASE_TIME,
          itemCount: 1,
          contentDigest: financeInsightDigestV1(facts as CanonicalJsonValue),
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          windowCount: 1,
          windowsDigest: financeInsightDigestV1(windows as unknown as CanonicalJsonValue),
          bridgeContractVersion: '1.0',
          completedAt: BASE_TIME,
          facts,
          windows,
        };

        await expect(backfill.promoteCompletedPlan({ ...promotionInput, generationId: 'generation-first' }))
          .resolves.toEqual({ promoted: true });
        // Idempotent retry with the identical generation and payload: a no-op.
        await expect(backfill.promoteCompletedPlan({ ...promotionInput, generationId: 'generation-first' }))
          .resolves.toEqual({ promoted: false });
        // Idempotent retry with the *same* generation but drifted payload conflicts.
        await expect(backfill.promoteCompletedPlan({
          ...promotionInput,
          generationId: 'generation-first',
          itemCount: 2,
        })).rejects.toMatchObject({ name: 'FinanceInsightBackfillProjectionConflictError' });

        // A genuinely different generation already being current also conflicts
        // (it must not silently overwrite the prior promotion), and the prior
        // generation's promoted state is left untouched by the rejected call.
        await expect(backfill.promoteCompletedPlan({ ...promotionInput, generationId: 'generation-second' }))
          .rejects.toMatchObject({ name: 'FinanceInsightBackfillProjectionConflictError' });
        await expect(projection.readState(CONNECTOR_ID))
          .resolves.toMatchObject({ generationId: 'generation-first' });
      });

      it('throws plan-unavailable when the plan is not completed or the identity does not match', async () => {
        const { backfill } = harness.repositories;
        const plan = await backfill.createPlan({
          connectorId: CONNECTOR_ID,
          idempotencyKey: 'plan-unready',
          horizonMonths: 1,
          currency: 'USD',
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          bridgeContractVersion: '1.0',
          windowCount: 1,
          now: BASE_TIME,
        });

        await expect(backfill.promoteCompletedPlan({
          connectorId: CONNECTOR_ID,
          planId: plan.id,
          idempotencyKey: 'plan-unready',
          generationId: 'generation-unready',
          sourceAsOf: BASE_TIME,
          itemCount: 0,
          contentDigest: financeInsightDigestV1([] as CanonicalJsonValue),
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          windowCount: 0,
          windowsDigest: financeInsightDigestV1([] as unknown as CanonicalJsonValue),
          bridgeContractVersion: '1.0',
          completedAt: BASE_TIME,
          facts: [],
          windows: [],
        })).rejects.toMatchObject({ name: 'FinanceInsightBackfillPlanUnavailableError' });

        await expect(backfill.promoteCompletedPlan({
          connectorId: CONNECTOR_ID,
          planId: 'nonexistent-plan-id',
          idempotencyKey: 'plan-unready',
          generationId: 'generation-unready',
          sourceAsOf: BASE_TIME,
          itemCount: 0,
          contentDigest: financeInsightDigestV1([] as CanonicalJsonValue),
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          windowCount: 0,
          windowsDigest: financeInsightDigestV1([] as unknown as CanonicalJsonValue),
          bridgeContractVersion: '1.0',
          completedAt: BASE_TIME,
          facts: [],
          windows: [],
        })).rejects.toMatchObject({ name: 'FinanceInsightBackfillPlanUnavailableError' });
      });
    });

    describe('publication capture', () => {
      it('captures with a monotonically expected sequence and rejects a mismatched one as a conflict', async () => {
        const { publication } = harness.repositories;
        await expect(publication.readCurrentState(CONNECTOR_ID)).resolves.toBeNull();

        await expect(publication.capture({
          connectorId: CONNECTOR_ID,
          providerType: 'monarch-money',
          capturedAt: BASE_TIME,
          generationIdentity: 'generation-one',
          expectedSourceSequence: 5, // wrong: current is 0, expected must be 1
          publicationId: 'publication-conflict',
          idempotencyKey: 'idempotency-conflict',
          createRequest: {},
          contractVersion: '1.0',
          sourceAsOf: BASE_TIME,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          currency: 'USD',
          bridgeContractVersion: '1.0',
          capturedConstituents: {},
          manifest: {},
          manifestDigest: 'manifest-digest',
          expiresAt: '2026-09-08T00:00:00.000Z',
          cacheCount: 5,
          facts: [],
        })).resolves.toEqual({ status: 'conflict' });

        await expect(publication.capture({
          connectorId: CONNECTOR_ID,
          providerType: 'monarch-money',
          capturedAt: BASE_TIME,
          generationIdentity: 'generation-one',
          expectedSourceSequence: 1,
          publicationId: 'publication-one',
          idempotencyKey: 'idempotency-one',
          createRequest: {},
          contractVersion: '1.0',
          sourceAsOf: BASE_TIME,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          currency: 'USD',
          bridgeContractVersion: '1.0',
          capturedConstituents: {},
          manifest: {},
          manifestDigest: 'manifest-digest',
          expiresAt: '2026-09-08T00:00:00.000Z',
          cacheCount: 5,
          facts: [{ kind: 'transaction', sourceRef: 'txn-a', batchIndex: 0, factIndex: 0, payload: { a: 1 } }],
        })).resolves.toEqual({ status: 'captured', publicationId: 'publication-one', sourceSequence: 1 });

        await expect(publication.readCurrentState(CONNECTOR_ID)).resolves.toEqual({
          publicationId: 'publication-one',
          generationIdentity: 'generation-one',
          sourceSequence: 1,
        });
      });

      it('captures idempotently for a repeated generation identity regardless of the supplied sequence', async () => {
        const { publication } = harness.repositories;
        await publication.capture({
          connectorId: CONNECTOR_ID,
          providerType: 'monarch-money',
          capturedAt: BASE_TIME,
          generationIdentity: 'generation-repeat',
          expectedSourceSequence: 1,
          publicationId: 'publication-repeat',
          idempotencyKey: 'idempotency-repeat',
          createRequest: {},
          contractVersion: '1.0',
          sourceAsOf: BASE_TIME,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          currency: 'USD',
          bridgeContractVersion: '1.0',
          capturedConstituents: {},
          manifest: {},
          manifestDigest: 'manifest-digest',
          expiresAt: '2026-09-08T00:00:00.000Z',
          cacheCount: 5,
          facts: [],
        });

        await expect(publication.capture({
          connectorId: CONNECTOR_ID,
          providerType: 'monarch-money',
          capturedAt: '2026-09-01T00:05:00.000Z',
          generationIdentity: 'generation-repeat', // same identity as before
          expectedSourceSequence: 999, // deliberately wrong/irrelevant for idempotent replay
          publicationId: 'publication-repeat',
          idempotencyKey: 'idempotency-repeat',
          createRequest: {},
          contractVersion: '1.0',
          sourceAsOf: BASE_TIME,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          currency: 'USD',
          bridgeContractVersion: '1.0',
          capturedConstituents: {},
          manifest: {},
          manifestDigest: 'manifest-digest',
          expiresAt: '2026-09-08T00:00:00.000Z',
          cacheCount: 5,
          facts: [],
        })).resolves.toEqual({ status: 'idempotent', publicationId: 'publication-repeat', sourceSequence: 1 });
      });

      it('rolls back a capture entirely when a duplicate fact violates the unique constraint', async () => {
        const { publication } = harness.repositories;
        await expect(publication.capture({
          connectorId: CONNECTOR_ID,
          providerType: 'monarch-money',
          capturedAt: BASE_TIME,
          generationIdentity: 'generation-rollback',
          expectedSourceSequence: 1,
          publicationId: 'publication-rollback',
          idempotencyKey: 'idempotency-rollback',
          createRequest: {},
          contractVersion: '1.0',
          sourceAsOf: BASE_TIME,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          currency: 'USD',
          bridgeContractVersion: '1.0',
          capturedConstituents: {},
          manifest: {},
          manifestDigest: 'manifest-digest',
          expiresAt: '2026-09-08T00:00:00.000Z',
          cacheCount: 5,
          facts: [
            { kind: 'transaction', sourceRef: 'txn-dup', batchIndex: 0, factIndex: 0, payload: {} },
            { kind: 'transaction', sourceRef: 'txn-dup', batchIndex: 0, factIndex: 1, payload: {} },
          ],
        })).rejects.toThrow();

        await expect(publication.readCurrentState(CONNECTOR_ID)).resolves.toBeNull();
        await expect(publication.loadLatest(CONNECTOR_ID, null, BASE_TIME)).resolves.toBeNull();
      });

      it('does not clobber captured lineage when recordOutcome is called after a successful capture', async () => {
        const { publication } = harness.repositories;
        await publication.capture({
          connectorId: CONNECTOR_ID,
          providerType: 'monarch-money',
          capturedAt: BASE_TIME,
          generationIdentity: 'generation-outcome',
          expectedSourceSequence: 1,
          publicationId: 'publication-outcome',
          idempotencyKey: 'idempotency-outcome',
          createRequest: {},
          contractVersion: '1.0',
          sourceAsOf: BASE_TIME,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          currency: 'USD',
          bridgeContractVersion: '1.0',
          capturedConstituents: {},
          manifest: {},
          manifestDigest: 'manifest-digest',
          expiresAt: '2026-09-08T00:00:00.000Z',
          cacheCount: 5,
          facts: [],
        });

        await publication.recordOutcome({
          connectorId: CONNECTOR_ID,
          providerType: 'monarch-money',
          now: '2026-09-01T00:10:00.000Z',
          outcome: 'failed',
          code: 'downstream-error',
        });

        await expect(publication.readCurrentState(CONNECTOR_ID)).resolves.toEqual({
          publicationId: 'publication-outcome',
          generationIdentity: 'generation-outcome',
          sourceSequence: 1,
        });
      });

      it('loads the latest still-fresh publication and filters by expiry and by publication id', async () => {
        const { publication } = harness.repositories;
        await publication.capture({
          connectorId: CONNECTOR_ID,
          providerType: 'monarch-money',
          capturedAt: BASE_TIME,
          generationIdentity: 'generation-expiry',
          expectedSourceSequence: 1,
          publicationId: 'publication-expiry',
          idempotencyKey: 'idempotency-expiry',
          createRequest: { requested: true },
          contractVersion: '1.0',
          sourceAsOf: BASE_TIME,
          coverageStart: '2026-08-01',
          coverageEnd: '2026-08-31',
          currency: 'USD',
          bridgeContractVersion: '1.0',
          capturedConstituents: {},
          manifest: {},
          manifestDigest: 'manifest-digest',
          expiresAt: '2026-09-02T00:00:00.000Z',
          cacheCount: 5,
          facts: [{ kind: 'transaction', sourceRef: 'txn-a', batchIndex: 0, factIndex: 0, payload: { a: 1 } }],
        });

        await expect(publication.loadLatest(CONNECTOR_ID, null, '2026-09-01T12:00:00.000Z'))
          .resolves.toMatchObject({
            record: { id: 'publication-expiry', createRequest: { requested: true } },
            facts: [{ kind: 'transaction', sourceRef: 'txn-a', payload: { a: 1 } }],
          });
        // Past the expiry: no longer "fresh".
        await expect(publication.loadLatest(CONNECTOR_ID, null, '2026-09-03T00:00:00.000Z'))
          .resolves.toBeNull();
        // A mismatched explicit publication id also yields nothing.
        await expect(publication.loadLatest(CONNECTOR_ID, 'someone-elses-publication', '2026-09-01T12:00:00.000Z'))
          .resolves.toBeNull();
      });
    });

    describe('delivery checkpoints', () => {
      it('creates a checkpoint once (idempotently) and advances it forward through its stages', async () => {
        const { delivery } = harness.repositories;
        await capturePublicationForDelivery(
          harness.repositories, CONNECTOR_ID, 'publication-delivery', 1, 'generation-delivery',
        );
        const created = await delivery.ensureState({
          connectorId: CONNECTOR_ID,
          publicationId: 'publication-delivery',
          sourceSequence: 1,
          now: BASE_TIME,
        });
        expect(created).toEqual({
          stage: 'captured',
          nextBatchOrdinal: 0,
          detectorSetVersion: null,
          policyVersion: null,
          evaluationSequence: null,
        });
        // Calling ensureState again must not reset an already-advanced state.
        await delivery.markStaging({ publicationId: 'publication-delivery', now: BASE_TIME });
        await expect(delivery.ensureState({
          connectorId: CONNECTOR_ID,
          publicationId: 'publication-delivery',
          sourceSequence: 1,
          now: BASE_TIME,
        })).resolves.toMatchObject({ stage: 'staging' });

        await delivery.advanceBatch({ publicationId: 'publication-delivery', nextBatchOrdinal: 1, now: BASE_TIME });
        await expect(harness.deliveryRow('publication-delivery'))
          .resolves.toMatchObject({ stage: 'uploading', nextBatchOrdinal: 1 });

        await delivery.markCommitted({
          publicationId: 'publication-delivery',
          detectorSetVersion: 'detector-v1',
          policyVersion: 3,
          now: BASE_TIME,
        });
        await expect(harness.deliveryRow('publication-delivery')).resolves.toMatchObject({
          stage: 'committed',
          detectorSetVersion: 'detector-v1',
          policyVersion: 3,
        });
      });

      it('never regresses stage or batch ordinal for a stale/duplicate delivery call, even past committed and evaluation-requested', async () => {
        const { delivery } = harness.repositories;
        await capturePublicationForDelivery(
          harness.repositories, CONNECTOR_ID, 'publication-monotonic', 1, 'generation-monotonic',
        );
        await delivery.ensureState({
          connectorId: CONNECTOR_ID,
          publicationId: 'publication-monotonic',
          sourceSequence: 1,
          now: BASE_TIME,
        });
        await delivery.markStaging({ publicationId: 'publication-monotonic', now: BASE_TIME });
        await delivery.advanceBatch({
          publicationId: 'publication-monotonic',
          nextBatchOrdinal: 3,
          now: BASE_TIME,
        });
        await delivery.markCommitted({
          publicationId: 'publication-monotonic',
          detectorSetVersion: 'detector-v1',
          policyVersion: 1,
          now: BASE_TIME,
        });

        // A stale retry of an earlier stage must not regress `stage`.
        await delivery.markStaging({ publicationId: 'publication-monotonic', now: '2026-09-01T00:05:00.000Z' });
        await expect(harness.deliveryRow('publication-monotonic'))
          .resolves.toMatchObject({ stage: 'committed' });

        // A stale/lower batch ordinal must not regress `nextBatchOrdinal`.
        await delivery.advanceBatch({
          publicationId: 'publication-monotonic',
          nextBatchOrdinal: 1,
          now: '2026-09-01T00:05:00.000Z',
        });
        await expect(harness.deliveryRow('publication-monotonic'))
          .resolves.toMatchObject({ stage: 'committed', nextBatchOrdinal: 3 });

        // Once evaluation has been requested, it is a terminal stage: none of
        // markStaging/advanceBatch/markCommitted may drag it back down.
        await delivery.recordEvaluationOutcome({
          publicationId: 'publication-monotonic',
          evaluationSequence: 5,
          evaluationState: 'queued',
          evaluationIdempotencyKey: 'eval-key-monotonic',
          now: '2026-09-01T00:06:00.000Z',
          succeeded: true,
          errorCode: null,
          retryable: false,
        });
        await expect(harness.deliveryRow('publication-monotonic'))
          .resolves.toMatchObject({ stage: 'evaluation-requested' });

        await delivery.markStaging({ publicationId: 'publication-monotonic', now: '2026-09-01T00:07:00.000Z' });
        await expect(harness.deliveryRow('publication-monotonic'))
          .resolves.toMatchObject({ stage: 'evaluation-requested' });

        await delivery.markCommitted({
          publicationId: 'publication-monotonic',
          detectorSetVersion: 'detector-v2',
          policyVersion: 2,
          now: '2026-09-01T00:08:00.000Z',
        });
        await expect(harness.deliveryRow('publication-monotonic')).resolves.toMatchObject({
          stage: 'evaluation-requested',
          // markCommitted's other fields still apply even while the stage itself is guarded.
          detectorSetVersion: 'detector-v2',
          policyVersion: 2,
        });

        // A stale/lower batch ordinal still must not regress even in this stage.
        await delivery.advanceBatch({
          publicationId: 'publication-monotonic',
          nextBatchOrdinal: 2,
          now: '2026-09-01T00:09:00.000Z',
        });
        await expect(harness.deliveryRow('publication-monotonic'))
          .resolves.toMatchObject({ stage: 'evaluation-requested', nextBatchOrdinal: 3 });

        // A genuinely later batch ordinal still advances (batch progress can
        // keep climbing independently of the delivery stage), without ever
        // pulling the stage itself back down from evaluation-requested.
        await delivery.advanceBatch({
          publicationId: 'publication-monotonic',
          nextBatchOrdinal: 4,
          now: '2026-09-01T00:10:00.000Z',
        });
        await expect(harness.deliveryRow('publication-monotonic'))
          .resolves.toMatchObject({ stage: 'evaluation-requested', nextBatchOrdinal: 4 });
      });

      it('records evaluation outcomes and exposes the max evaluation sequence across other publications', async () => {
        const { delivery } = harness.repositories;
        await capturePublicationForDelivery(
          harness.repositories, CONNECTOR_ID, 'publication-eval-a', 1, 'generation-eval-a',
        );
        await capturePublicationForDelivery(
          harness.repositories, CONNECTOR_ID, 'publication-eval-b', 2, 'generation-eval-b',
        );
        await delivery.ensureState({
          connectorId: CONNECTOR_ID,
          publicationId: 'publication-eval-a',
          sourceSequence: 1,
          now: BASE_TIME,
        });
        await delivery.ensureState({
          connectorId: CONNECTOR_ID,
          publicationId: 'publication-eval-b',
          sourceSequence: 2,
          now: BASE_TIME,
        });

        await delivery.recordEvaluationOutcome({
          publicationId: 'publication-eval-a',
          evaluationSequence: 10,
          evaluationState: 'succeeded',
          evaluationIdempotencyKey: 'eval-key-a',
          now: BASE_TIME,
          succeeded: true,
          errorCode: null,
          retryable: false,
        });
        await expect(harness.deliveryRow('publication-eval-a')).resolves.toMatchObject({
          stage: 'evaluation-requested',
          evaluationSequence: 10,
          evaluationState: 'succeeded',
          lastErrorCode: null,
        });
        await expect(delivery.readMaxEvaluationSequence({
          connectorId: CONNECTOR_ID,
          excludingPublicationId: 'publication-eval-a',
        })).resolves.toBeNull();

        await delivery.recordEvaluationOutcome({
          publicationId: 'publication-eval-b',
          evaluationSequence: 20,
          evaluationState: 'failed',
          evaluationIdempotencyKey: 'eval-key-b',
          now: BASE_TIME,
          succeeded: false,
          errorCode: 'evaluator-timeout',
          retryable: true,
        });
        await expect(harness.deliveryRow('publication-eval-b')).resolves.toMatchObject({
          evaluationSequence: 20,
          lastErrorCode: 'evaluator-timeout',
          lastErrorRetryable: true,
        });
        await expect(delivery.readMaxEvaluationSequence({
          connectorId: CONNECTOR_ID,
          excludingPublicationId: 'publication-eval-b',
        })).resolves.toBe(10);
      });

      it('resolves the most recent pending/retryable publication as the continuation target', async () => {
        const { delivery } = harness.repositories;
        await expect(delivery.findContinuationPublicationId(CONNECTOR_ID)).resolves.toBeNull();

        await capturePublicationForDelivery(
          harness.repositories, CONNECTOR_ID, 'publication-continuation-a', 1, 'generation-continuation-a',
        );
        await capturePublicationForDelivery(
          harness.repositories, CONNECTOR_ID, 'publication-continuation-b', 2, 'generation-continuation-b',
        );
        await delivery.ensureState({
          connectorId: CONNECTOR_ID,
          publicationId: 'publication-continuation-a',
          sourceSequence: 1,
          now: BASE_TIME,
        });
        await delivery.ensureState({
          connectorId: CONNECTOR_ID,
          publicationId: 'publication-continuation-b',
          sourceSequence: 2,
          now: BASE_TIME,
        });
        await delivery.recordEvaluationOutcome({
          publicationId: 'publication-continuation-b',
          evaluationSequence: 1,
          evaluationState: 'queued',
          evaluationIdempotencyKey: 'eval-key-continuation',
          now: BASE_TIME,
          succeeded: true,
          errorCode: null,
          retryable: false,
        });

        await expect(delivery.findContinuationPublicationId(CONNECTOR_ID))
          .resolves.toBe('publication-continuation-b');
      });
    });

    describe('occurrence cache', () => {
      it('replaces the cache generation and reads back current rows', async () => {
        const { occurrenceCache } = harness.repositories;
        const item = occurrenceItem('occurrence-one');
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-initial',
          sourceSequence: 1,
          sourceAsOf: BASE_TIME,
          refreshedAt: BASE_TIME,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [item],
        });

        await expect(occurrenceCache.readState(CONNECTOR_ID)).resolves.toMatchObject({
          sourceGeneration: 'generation-initial',
          sourceSequence: 1,
        });
        await expect(occurrenceCache.readCurrentGenerationRows(CONNECTOR_ID, 'generation-initial', 10))
          .resolves.toEqual([{
            occurrenceId: 'occurrence-one',
            insightId: 'insight-one',
            kind: 'transaction-anomaly',
            sourceLifecycle: 'open',
            updatedAt: BASE_TIME,
            summaryPayload: { note: 'example' },
          }]);
      });

      it('idempotently refreshes without rewriting rows when nothing has changed', async () => {
        const { occurrenceCache } = harness.repositories;
        const replaceInput = {
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-idempotent',
          sourceSequence: 1,
          sourceAsOf: BASE_TIME,
          refreshedAt: BASE_TIME,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-refresh')],
        };
        await occurrenceCache.replace(replaceInput);
        await expect(occurrenceCache.replace({
          ...replaceInput,
          refreshedAt: '2026-09-01T00:30:00.000Z',
        })).resolves.toBeUndefined();

        await expect(occurrenceCache.readState(CONNECTOR_ID)).resolves.toMatchObject({
          sourceGeneration: 'generation-idempotent',
          sourceSequence: 1,
        });
        await expect(harness.occurrenceRowCount(CONNECTOR_ID)).resolves.toBe(1);
      });

      it('enforces generation identity immutability, staleness, and cross-generation sequence conflicts', async () => {
        const { occurrenceCache } = harness.repositories;
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-a',
          sourceSequence: 1,
          sourceAsOf: BASE_TIME,
          refreshedAt: BASE_TIME,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [],
        });

        // Same generation string, a different sequence: identity is immutable.
        await expect(occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-a',
          sourceSequence: 5,
          sourceAsOf: BASE_TIME,
          refreshedAt: BASE_TIME,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [],
        })).rejects.toThrow('identity is immutable');

        // Advance legitimately to a new generation with a higher sequence.
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-b',
          sourceSequence: 2,
          sourceAsOf: '2026-09-01T01:00:00.000Z',
          refreshedAt: '2026-09-01T01:00:00.000Z',
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [],
        });

        // A lower sequence than the current one: stale.
        await expect(occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-c',
          sourceSequence: 1,
          sourceAsOf: '2026-09-01T02:00:00.000Z',
          refreshedAt: '2026-09-01T02:00:00.000Z',
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [],
        })).rejects.toThrow('generation is stale');

        // The same sequence as the current one, but a different generation: conflict.
        await expect(occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-d',
          sourceSequence: 2,
          sourceAsOf: '2026-09-01T02:00:00.000Z',
          refreshedAt: '2026-09-01T02:00:00.000Z',
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [],
        })).rejects.toThrow('generation conflicts');
      });

      it('enforces per-item revision staleness, conflicts, and a stale reopen on a legitimate generation advance', async () => {
        const { occurrenceCache } = harness.repositories;
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-item-a',
          sourceSequence: 10,
          sourceAsOf: BASE_TIME,
          refreshedAt: BASE_TIME,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [
            occurrenceItem('occurrence-open', {
              deliveryRevision: 5,
              revisionDigest: 'digest-five',
              sourceLifecycle: 'open',
              updatedAt: BASE_TIME,
            }),
            occurrenceItem('occurrence-resolved', {
              deliveryRevision: 5,
              revisionDigest: 'digest-five-resolved',
              sourceLifecycle: 'resolved',
              updatedAt: BASE_TIME,
            }),
          ],
        });
        const laterAsOf = '2026-09-01T01:00:00.000Z';

        // Lower delivery revision than stored: stale.
        await expect(occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-item-b',
          sourceSequence: 11,
          sourceAsOf: laterAsOf,
          refreshedAt: laterAsOf,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-open', {
            deliveryRevision: 4,
            revisionDigest: 'irrelevant',
            sourceLifecycle: 'open',
            updatedAt: laterAsOf,
          })],
        })).rejects.toThrow('revision is stale');

        // Same delivery revision, different digest: conflicts.
        await expect(occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-item-c',
          sourceSequence: 11,
          sourceAsOf: laterAsOf,
          refreshedAt: laterAsOf,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-open', {
            deliveryRevision: 5,
            revisionDigest: 'digest-different',
            sourceLifecycle: 'open',
            updatedAt: laterAsOf,
          })],
        })).rejects.toThrow('revision conflicts');

        // Same revision, matching digest, but flips a non-open item back to
        // "open" without bumping the revision: lifecycle is stale.
        await expect(occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-item-d',
          sourceSequence: 11,
          sourceAsOf: laterAsOf,
          refreshedAt: laterAsOf,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-resolved', {
            deliveryRevision: 5,
            revisionDigest: 'digest-five-resolved',
            sourceLifecycle: 'open',
            updatedAt: laterAsOf,
          })],
        })).rejects.toThrow('lifecycle is stale');

        // None of the rejected attempts above should have changed the stored state.
        await expect(occurrenceCache.readState(CONNECTOR_ID)).resolves.toMatchObject({
          sourceGeneration: 'generation-item-a',
          sourceSequence: 10,
        });

        // A real advance with a bumped revision succeeds for both items.
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-item-e',
          sourceSequence: 11,
          sourceAsOf: laterAsOf,
          refreshedAt: laterAsOf,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [
            occurrenceItem('occurrence-open', {
              deliveryRevision: 6,
              revisionDigest: 'digest-six',
              sourceLifecycle: 'open',
              updatedAt: laterAsOf,
            }),
            occurrenceItem('occurrence-resolved', {
              deliveryRevision: 6,
              revisionDigest: 'digest-six-resolved',
              sourceLifecycle: 'open',
              updatedAt: laterAsOf,
            }),
          ],
        });
        await expect(occurrenceCache.readState(CONNECTOR_ID))
          .resolves.toMatchObject({ sourceGeneration: 'generation-item-e', sourceSequence: 11 });
      });

      it('tombstones a resolved/superseded row dropped from the next generation and immediately scrubs its payload', async () => {
        const { occurrenceCache } = harness.repositories;
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-tombstone-a',
          sourceSequence: 1,
          sourceAsOf: BASE_TIME,
          refreshedAt: BASE_TIME,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-to-resolve', { sourceLifecycle: 'resolved' })],
        });
        await expect(harness.occurrenceRow(CONNECTOR_ID, 'occurrence-to-resolve'))
          .resolves.toMatchObject({ isTombstone: false, sourceLifecycle: 'resolved' });

        // The next generation advance drops the item entirely (it is not
        // included), which tombstones and scrubs it rather than deleting it.
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-tombstone-b',
          sourceSequence: 2,
          sourceAsOf: '2026-09-01T01:00:00.000Z',
          refreshedAt: '2026-09-01T01:00:00.000Z',
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [],
        });

        await expect(harness.occurrenceRow(CONNECTOR_ID, 'occurrence-to-resolve')).resolves.toMatchObject({
          isTombstone: true,
          entityLabel: '',
          headline: '',
          targetDescriptors: [],
          summaryPayload: null,
        });
      });

      it('prunes excess tombstoned rows beyond the bounded tombstone limit', async () => {
        const { occurrenceCache } = harness.repositories;
        await harness.insertLegacyOccurrenceRow({
          connectorId: CONNECTOR_ID,
          occurrenceId: 'occurrence-tombstone-old',
          sourceGeneration: 'generation-prune',
          sourceSequence: 1,
          isTombstone: true,
          sourceLifecycle: 'resolved',
          deliveryRevision: 1,
          revisionDigest: 'digest-old',
          summaryPayload: null,
          sourceUpdatedAt: '2026-08-01T00:00:00.000Z',
          cachedAt: BASE_TIME,
        });
        await harness.insertLegacyOccurrenceRow({
          connectorId: CONNECTOR_ID,
          occurrenceId: 'occurrence-tombstone-new',
          sourceGeneration: 'generation-prune',
          sourceSequence: 1,
          isTombstone: true,
          sourceLifecycle: 'resolved',
          deliveryRevision: 1,
          revisionDigest: 'digest-new',
          summaryPayload: null,
          sourceUpdatedAt: '2026-08-15T00:00:00.000Z',
          cachedAt: BASE_TIME,
        });

        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-prune-next',
          sourceSequence: 2,
          sourceAsOf: '2026-09-01T01:00:00.000Z',
          refreshedAt: '2026-09-01T01:00:00.000Z',
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 1,
          items: [],
        });

        // Only the more-recently-updated tombstone survives the bounded prune.
        await expect(harness.occurrenceRow(CONNECTOR_ID, 'occurrence-tombstone-new'))
          .resolves.toMatchObject({ isTombstone: true });
        await expect(harness.occurrenceRow(CONNECTOR_ID, 'occurrence-tombstone-old')).resolves.toBeNull();
      });

      it('prune() independently scrubs stale payloads, hard-deletes expired tombstones, and purges expired connectors', async () => {
        const { occurrenceCache } = harness.repositories;
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-sweep',
          sourceSequence: 1,
          sourceAsOf: BASE_TIME,
          refreshedAt: BASE_TIME,
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-sweep-payload', { sourceLifecycle: 'open' })],
        });

        // Sweep 1: payload scrub for any row cached before the cutover, regardless of tombstone status.
        await occurrenceCache.prune('2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
        await expect(harness.occurrenceRow(CONNECTOR_ID, 'occurrence-sweep-payload')).resolves.toMatchObject({
          isTombstone: false,
          entityLabel: '',
          summaryPayload: null,
        });

        // Sweep 2: hard-delete tombstoned resolved/superseded rows older than the tombstone cutoff.
        await harness.insertLegacyOccurrenceRow({
          connectorId: CONNECTOR_ID,
          occurrenceId: 'occurrence-sweep-tombstone',
          sourceGeneration: 'generation-sweep',
          sourceSequence: 1,
          isTombstone: true,
          sourceLifecycle: 'resolved',
          deliveryRevision: 1,
          revisionDigest: 'digest',
          summaryPayload: null,
          sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
          cachedAt: '2026-01-01T00:00:00.000Z',
        });
        await occurrenceCache.prune('2020-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
        await expect(harness.occurrenceRow(CONNECTOR_ID, 'occurrence-sweep-tombstone')).resolves.toBeNull();

        // Sweep 3: fully purge a connector (and its cache-state row) once its purgeAfter has elapsed.
        await occurrenceCache.prune('2027-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
        await expect(occurrenceCache.readState(CONNECTOR_ID)).resolves.toBeNull();
        await expect(harness.occurrenceRowCount(CONNECTOR_ID)).resolves.toBe(0);
      });

      it('falls back to a legacy row\'s stored summary payload digest, and tolerates null summary payload/lifecycle round-trips', async () => {
        const { occurrenceCache } = harness.repositories;
        // A legacy row predating the revision_digest column: empty digest, null payload.
        await harness.insertLegacyOccurrenceRow({
          connectorId: CONNECTOR_ID,
          occurrenceId: 'occurrence-legacy',
          sourceGeneration: 'generation-legacy-a',
          sourceSequence: 1,
          isTombstone: false,
          sourceLifecycle: null,
          deliveryRevision: 1,
          revisionDigest: '',
          summaryPayload: null,
          sourceUpdatedAt: BASE_TIME,
          cachedAt: BASE_TIME,
        });

        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-legacy-b',
          sourceSequence: 2,
          sourceAsOf: '2026-09-01T01:00:00.000Z',
          refreshedAt: '2026-09-01T01:00:00.000Z',
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-legacy', {
            deliveryRevision: 2, // higher than the legacy row's revision: no staleness/conflict checks apply
            revisionDigest: 'digest-modern',
            sourceLifecycle: 'open',
            summaryPayload: null,
            updatedAt: '2026-09-01T01:00:00.000Z',
          })],
        });

        await expect(harness.occurrenceRow(CONNECTOR_ID, 'occurrence-legacy')).resolves.toMatchObject({
          sourceLifecycle: 'open',
          summaryPayload: null,
          revisionDigest: 'digest-modern',
        });
      });

      it('computes a fallback revision digest from a legacy row\'s empty column via its stored summary payload, accepting a matching same-revision write and rejecting a materially conflicting one', async () => {
        const { occurrenceCache } = harness.repositories;
        const legacyPayload = legacySummaryPayloadFixture();
        const fallbackDigest = financeInsightOccurrenceRevisionDigest(legacyPayload);

        async function seedLegacyRow(connectorId: string, occurrenceId: string) {
          await harness.insertLegacyOccurrenceRow({
            connectorId,
            occurrenceId,
            sourceGeneration: 'generation-legacy-fallback-a',
            sourceSequence: 1,
            isTombstone: false,
            sourceLifecycle: 'open',
            deliveryRevision: 1,
            revisionDigest: '', // legacy row predating the revision_digest column
            summaryPayload: legacyPayload,
            sourceUpdatedAt: BASE_TIME,
            cachedAt: BASE_TIME,
          });
        }

        // A same-revision write whose declared digest matches the digest
        // computed from the legacy row's stored summary payload is accepted,
        // even though the stored revision_digest column itself is empty.
        await seedLegacyRow(CONNECTOR_ID, 'occurrence-legacy-consistent');
        await occurrenceCache.replace({
          connectorId: CONNECTOR_ID,
          sourceGeneration: 'generation-legacy-fallback-b',
          sourceSequence: 2,
          sourceAsOf: '2026-09-01T01:00:00.000Z',
          refreshedAt: '2026-09-01T01:00:00.000Z',
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-legacy-consistent', {
            deliveryRevision: 1, // same revision as the legacy row: exercises the fallback comparison
            revisionDigest: fallbackDigest,
            sourceLifecycle: 'open',
            summaryPayload: null,
            updatedAt: BASE_TIME,
          })],
        });
        await expect(harness.occurrenceRow(CONNECTOR_ID, 'occurrence-legacy-consistent'))
          .resolves.toMatchObject({ deliveryRevision: 1, revisionDigest: fallbackDigest });

        // A same-revision write whose declared digest does NOT match the
        // digest computed from the legacy row's stored summary payload is a
        // material conflict and must be rejected, not silently accepted.
        // Uses a separate connector so this case's cache-state row is
        // independent of the first case's (avoiding an unrelated
        // generation-identity conflict at the cache-state level).
        await harness.seedConnector({ id: CONNECTOR_ID_SECOND });
        await seedLegacyRow(CONNECTOR_ID_SECOND, 'occurrence-legacy-conflicting');
        await expect(occurrenceCache.replace({
          connectorId: CONNECTOR_ID_SECOND,
          sourceGeneration: 'generation-legacy-fallback-c',
          sourceSequence: 2,
          sourceAsOf: '2026-09-01T01:00:00.000Z',
          refreshedAt: '2026-09-01T01:00:00.000Z',
          summaryExpiresAt: '2026-09-08T00:00:00.000Z',
          purgeAfter: '2026-12-01T00:00:00.000Z',
          tombstoneLimit: 10,
          items: [occurrenceItem('occurrence-legacy-conflicting', {
            deliveryRevision: 1, // same revision as the legacy row
            revisionDigest: 'a-different-digest-entirely',
            sourceLifecycle: 'open',
            summaryPayload: null,
            updatedAt: BASE_TIME,
          })],
        })).rejects.toThrow('revision conflicts');
        // Rejected write leaves the legacy row exactly as it was.
        await expect(harness.occurrenceRow(CONNECTOR_ID_SECOND, 'occurrence-legacy-conflicting')).resolves.toMatchObject({
          deliveryRevision: 1,
          revisionDigest: '',
          sourceGeneration: 'generation-legacy-fallback-a',
        });
      });
    });
  });
}
