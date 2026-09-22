import { beforeEach, describe, expect, it } from 'vitest';
import type { FinanceCorePersistence } from '@/db/persistence/finance-worker';
import type {
  FinanceAttributionRow,
  FinanceAttributionStateSnapshot,
} from '@/db/persistence/finance-attribution';
import type { FinanceSnapshotTransaction } from '@/db/persistence/finance-snapshot';

const CONNECTOR_ID = 'finance-worker-contract';
const BASE_TIME = '2026-08-30T12:00:00.000Z';
const WINDOW_START = '2026-08-01';
const WINDOW_END = '2026-08-30';

export interface FinanceWorkerContractHarness {
  repositories: FinanceCorePersistence;
  reset(): Promise<void>;
  seedConnector(credentials?: unknown): Promise<void>;
  credentials(): Promise<Record<string, unknown>>;
  transaction(upstreamId: string): Promise<{
    id: string;
    lifecycleStatus: string;
    assignedKidId: string | null;
    kidAssignmentMethod: string | null;
    manualDecisionAction: string | null;
    manualDecidedAt: string | null;
    attributionStatus: string;
    attributionReasons: unknown;
    attributionRetryable: boolean;
    isPending: boolean;
    tags: unknown;
    tagReferences: unknown;
    lastSeenAt: string;
  } | null>;
  transactionCount(): Promise<number>;
  setManualDecision(input: {
    upstreamId: string;
    action: 'assign-kid' | 'parent-expense';
    kidId: string | null;
    decidedAt: string;
  }): Promise<void>;
  syncState(): Promise<{
    status: string;
    generationId: string | null;
    lastSuccessfulGenerationId: string | null;
    lastErrorCode: string | null;
  } | null>;
  attributionException(upstreamId: string): Promise<{
    occurrenceCount: number;
    status: string;
  } | null>;
  referenceAccount(): Promise<{
    id: string;
    isActive: boolean;
    sourceIsActive: boolean;
    institution: string | null;
  } | null>;
  recurringGenerations(): Promise<Array<{
    generationId: string;
    isCurrent: boolean;
  }>>;
}

function snapshotTransaction(
  id: string,
  overrides: Partial<FinanceSnapshotTransaction> = {},
): FinanceSnapshotTransaction {
  return {
    id,
    date: '2026-08-15',
    amount: -12.5,
    merchant: { name: `Merchant ${id}`, logoUrl: null },
    category: null,
    account: { id: 'account-1', displayName: 'Checking', mask: null },
    isPending: true,
    isRecurring: false,
    notes: null,
    tags: ['Household'],
    tagReferences: [{ id: 'tag-1', name: 'Household' }],
    ...overrides,
  };
}

function startInput(generationId: string, attemptAt = BASE_TIME) {
  return {
    connectorId: CONNECTOR_ID,
    generationId,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    mode: 'backfill' as const,
    attemptAt,
  };
}

function pageInput(generationId: string, transactions: FinanceSnapshotTransaction[]) {
  return {
    connectorId: CONNECTOR_ID,
    generationId,
    transactions,
    provenance: { provider: 'live' as const, fetchedAt: BASE_TIME },
    observedAt: BASE_TIME,
  };
}

function completeInput(generationId: string) {
  return {
    connectorId: CONNECTOR_ID,
    generationId,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    projectionStartDate: WINDOW_START,
    sourceAsOf: BASE_TIME,
    completedAt: '2026-08-30T12:01:00.000Z',
    added: 0,
    updated: 0,
  };
}

function attributionSnapshot(row: FinanceAttributionRow): FinanceAttributionStateSnapshot {
  return {
    assignedKidId: row.assignedKidId,
    kidAssignmentMethod: row.kidAssignmentMethod,
    manualDecisionAction: row.manualDecisionAction,
    manualDecidedAt: row.manualDecidedAt,
  };
}

export function describeFinanceWorkerPersistenceContract(
  label: string,
  createHarness: () => Promise<FinanceWorkerContractHarness>,
): void {
  describe(`${label} finance worker persistence contract`, () => {
    let harness: FinanceWorkerContractHarness;

    beforeEach(async () => {
      harness ??= await createHarness();
      await harness.reset();
      await harness.seedConnector({ identityNamespace: 'a'.repeat(64) });
    });

    it('atomically installs one identity namespace and rejects invalid stored state', async () => {
      const first = 'a'.repeat(64);
      const second = 'b'.repeat(64);
      await expect(harness.repositories.identity.ensureNamespace({
        connectorId: CONNECTOR_ID,
        candidate: first,
        updatedAt: BASE_TIME,
      })).resolves.toBe(first);
      await expect(harness.repositories.identity.ensureNamespace({
        connectorId: CONNECTOR_ID,
        candidate: second,
        updatedAt: '2026-08-30T12:01:00.000Z',
      })).resolves.toBe(first);
      expect(await harness.credentials()).toMatchObject({ identityNamespace: first });

      await harness.reset();
      await harness.seedConnector({ identityNamespace: null });
      await expect(harness.repositories.identity.ensureNamespace({
        connectorId: CONNECTOR_ID,
        candidate: first,
        updatedAt: BASE_TIME,
      })).rejects.toThrow('identity state is invalid');
    });

    it('fences superseded snapshot generations and records only current failures', async () => {
      await harness.repositories.snapshots.start(startInput('generation-one'));
      await harness.repositories.snapshots.start(startInput(
        'generation-two',
        '2026-08-30T12:00:01.000Z',
      ));

      await expect(harness.repositories.snapshots.upsertPage(
        pageInput('generation-one', [snapshotTransaction('stale')]),
      )).rejects.toMatchObject({ code: 'finance_snapshot_generation_stale' });
      await expect(harness.repositories.snapshots.fail({
        connectorId: CONNECTOR_ID,
        generationId: 'generation-one',
        failedAt: '2026-08-30T12:00:02.000Z',
        errorCode: 'stale_failure',
        errorMessage: 'stale failure',
      })).resolves.toEqual({ recorded: false });

      await harness.repositories.snapshots.upsertPage(
        pageInput('generation-two', [snapshotTransaction('current')]),
      );
      await expect(harness.repositories.snapshots.fail({
        connectorId: CONNECTOR_ID,
        generationId: 'generation-two',
        failedAt: '2026-08-30T12:00:03.000Z',
        errorCode: 'current_failure',
        errorMessage: 'current failure',
      })).resolves.toEqual({ recorded: true });
      expect(await harness.syncState()).toMatchObject({
        status: 'failed',
        generationId: 'generation-two',
        lastErrorCode: 'current_failure',
      });
    });

    it('rolls back a page error and tombstones only after authoritative completion', async () => {
      await harness.repositories.snapshots.start(startInput('rollback-generation'));
      await expect(harness.repositories.snapshots.upsertPage(pageInput(
        'rollback-generation',
        [
          snapshotTransaction('valid-before-error'),
          snapshotTransaction('invalid', { date: null as never }),
        ],
      ))).rejects.toBeTruthy();
      expect(await harness.transactionCount()).toBe(0);

      await harness.repositories.snapshots.upsertPage(
        pageInput('rollback-generation', [snapshotTransaction('old')]),
      );
      await harness.repositories.snapshots.complete(completeInput('rollback-generation'));

      await harness.repositories.snapshots.start(startInput(
        'failed-generation',
        '2026-08-30T12:02:00.000Z',
      ));
      await harness.repositories.snapshots.upsertPage(
        pageInput('failed-generation', [snapshotTransaction('new')]),
      );
      await harness.repositories.snapshots.fail({
        connectorId: CONNECTOR_ID,
        generationId: 'failed-generation',
        failedAt: '2026-08-30T12:03:00.000Z',
        errorCode: 'interrupted',
        errorMessage: 'interrupted',
      });
      expect(await harness.transaction('old')).toMatchObject({ lifecycleStatus: 'active' });

      await harness.repositories.snapshots.start(startInput(
        'complete-generation',
        '2026-08-30T12:04:00.000Z',
      ));
      await harness.repositories.snapshots.upsertPage(
        pageInput('complete-generation', [snapshotTransaction('new')]),
      );
      await expect(harness.repositories.snapshots.complete(
        completeInput('complete-generation'),
      )).resolves.toEqual({ removed: 1 });
      expect(await harness.transaction('old')).toMatchObject({ lifecycleStatus: 'deleted' });
      expect(await harness.transaction('new')).toMatchObject({
        id: `finance:${CONNECTOR_ID}:new`,
        lifecycleStatus: 'active',
        isPending: true,
        tags: ['Household'],
        tagReferences: ['tag-1'],
      });
    });

    it('derives the next snapshot basis from the successful checkpoint and legacy tags', async () => {
      await harness.repositories.snapshots.start(startInput('basis-generation'));
      await harness.repositories.snapshots.upsertPage(pageInput(
        'basis-generation',
        [snapshotTransaction('legacy-tags', { tagReferences: [] })],
      ));
      await harness.repositories.snapshots.complete(completeInput('basis-generation'));

      await expect(harness.repositories.snapshots.readBasis(
        CONNECTOR_ID,
        WINDOW_START,
      )).resolves.toEqual({
        lastSuccessfulWindowEnd: WINDOW_END,
        needsStableTagBackfill: true,
      });
    });

    it('publishes reference values and retains only current plus previous snapshots', async () => {
      const datasets = harness.repositories.datasets;
      await datasets.recordAttempt({
        connectorId: CONNECTOR_ID,
        dataset: 'accounts',
        attemptAt: BASE_TIME,
        sourceLimit: 1_000,
        schemaVersion: '1.0',
        configVersion: 1,
      });
      await datasets.publishReference({
        connectorId: CONNECTOR_ID,
        dataset: 'accounts',
        attemptAt: BASE_TIME,
        generationId: 'accounts-one',
        completedAt: BASE_TIME,
        sourceAsOf: BASE_TIME,
        freshUntil: '2026-08-31T12:00:00.000Z',
        coverageStart: null,
        coverageEnd: null,
        sourceLimit: 1_000,
        schemaVersion: '1.0',
        configVersion: 1,
        items: [{
          id: 'account-1',
          displayName: 'Checking',
          type: 'checking',
          institution: null,
          mask: null,
          isActive: true,
        }],
      });
      expect(await harness.referenceAccount()).toEqual({
        id: `finance:account:${CONNECTOR_ID}:account-1`,
        isActive: true,
        sourceIsActive: true,
        institution: null,
      });

      for (let index = 1; index <= 3; index++) {
        const attemptAt = `2026-08-30T12:1${index}:00.000Z`;
        await datasets.recordAttempt({
          connectorId: CONNECTOR_ID,
          dataset: 'recurring',
          attemptAt,
          sourceLimit: 10_000,
          schemaVersion: '1.0',
          configVersion: 1,
        });
        await datasets.publishRecurring({
          connectorId: CONNECTOR_ID,
          dataset: 'recurring',
          attemptAt,
          generationId: `recurring-${index}`,
          completedAt: attemptAt,
          sourceAsOf: BASE_TIME,
          freshUntil: '2026-08-31T12:00:00.000Z',
          coverageStart: null,
          coverageEnd: null,
          sourceLimit: 10_000,
          schemaVersion: '1.0',
          configVersion: 1,
          items: [{
            id: `recurring-item-${index}`,
            merchant: `Merchant ${index}`,
            amount: -index,
            frequency: 'monthly',
            nextExpectedDate: null,
            account: null,
            category: null,
          }],
        });
      }
      expect(await harness.recurringGenerations()).toEqual([
        { generationId: 'recurring-2', isCurrent: false },
        { generationId: 'recurring-3', isCurrent: true },
      ]);

      const budgetAttempt = '2026-08-30T12:20:00.000Z';
      await datasets.recordAttempt({
        connectorId: CONNECTOR_ID,
        dataset: 'budgets',
        attemptAt: budgetAttempt,
        sourceLimit: 5_000,
        schemaVersion: '1.0',
        configVersion: 1,
      });
      await expect(datasets.publishBudgets({
        connectorId: CONNECTOR_ID,
        dataset: 'budgets',
        attemptAt: budgetAttempt,
        generationId: 'budgets-one',
        completedAt: budgetAttempt,
        sourceAsOf: BASE_TIME,
        freshUntil: '2026-08-31T12:00:00.000Z',
        coverageStart: '2026-08-01',
        coverageEnd: '2026-08-31',
        sourceLimit: 5_000,
        schemaVersion: '1.0',
        configVersion: 1,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        items: [{
          category: { id: 'category-1', name: 'Food' },
          budgeted: 500,
          spent: 125,
          remaining: 375,
          percentUsed: 25,
        }],
      })).resolves.toEqual({
        added: 1,
        updated: 0,
        removed: 0,
        count: 1,
      });
      expect((await datasets.listState(CONNECTOR_ID))
        .find((state) => state.dataset === 'budgets')).toMatchObject({
        currentGenerationId: 'budgets-one',
        publishedItemCount: 1,
        coverageStart: '2026-08-01',
        coverageEnd: '2026-08-31',
      });
    });

    it('fences delayed dataset failures behind a newer successful attempt', async () => {
      const datasets = harness.repositories.datasets;
      await datasets.recordAttempt({
        connectorId: CONNECTOR_ID,
        dataset: 'tags',
        attemptAt: BASE_TIME,
        sourceLimit: 1_000,
        schemaVersion: '1.0',
        configVersion: 1,
      });
      const newer = '2026-08-30T12:05:00.000Z';
      await datasets.recordAttempt({
        connectorId: CONNECTOR_ID,
        dataset: 'tags',
        attemptAt: newer,
        sourceLimit: 1_000,
        schemaVersion: '1.0',
        configVersion: 1,
      });
      await expect(datasets.recordFailure({
        connectorId: CONNECTOR_ID,
        dataset: 'tags',
        attemptAt: BASE_TIME,
        failedAt: '2026-08-30T12:06:00.000Z',
        errorCode: 'stale',
        sourceLimit: 1_000,
        schemaVersion: '1.0',
        configVersion: 1,
      })).resolves.toEqual({ recorded: false });
      expect((await datasets.listState(CONNECTOR_ID))
        .find((state) => state.dataset === 'tags')).toMatchObject({
        lastAttemptAt: newer,
        lastAttemptOutcome: null,
      });
    });

    it('round-trips attribution JSON/booleans and null-safely protects manual decisions', async () => {
      await harness.repositories.snapshots.start(startInput('attribution-generation'));
      await harness.repositories.snapshots.upsertPage(pageInput(
        'attribution-generation',
        [
          snapshotTransaction('attribution'),
          snapshotTransaction('automated-attribution'),
        ],
      ));
      const rows = await harness.repositories.attribution.readRows(
        CONNECTOR_ID,
        ['attribution', 'automated-attribution'],
      );
      const captured = rows.get('attribution')!;
      const automated = rows.get('automated-attribution')!;
      await harness.setManualDecision({
        upstreamId: 'attribution',
        action: 'parent-expense',
        kidId: null,
        decidedAt: '2026-08-30T12:10:00.000Z',
      });
      await harness.repositories.attribution.applyResults({
        connectorId: CONNECTOR_ID,
        generationId: 'attribution-generation',
        now: '2026-08-30T12:11:00.000Z',
        provenance: 'contract-test',
        items: [
          {
            transactionId: captured.id,
            sourceFingerprint: captured.sourceFingerprint,
            sourceRef: 'transaction-v1:manual-conflict',
            stateSnapshot: attributionSnapshot(captured),
            hasManualDecision: false,
            manualResultMatches: true,
            result: {
              contractVersion: '2.0',
              sourceRef: 'transaction-v1:manual-conflict',
              status: 'attributed',
              kidId: 'kid-one',
              confidence: 'definite',
              method: 'account-rule',
              explanation: 'Matched account',
              reviewStatus: 'not-required',
              reasons: [],
              decisionSource: 'automated',
              policyVersion: 7,
              engineVersion: '2.0.0',
              evaluatedAt: '2026-08-30T12:10:30.000Z',
            },
          },
          {
            transactionId: automated.id,
            sourceFingerprint: automated.sourceFingerprint,
            sourceRef: 'transaction-v1:automated',
            stateSnapshot: attributionSnapshot(automated),
            hasManualDecision: false,
            manualResultMatches: true,
            result: {
              contractVersion: '2.0',
              sourceRef: 'transaction-v1:automated',
              status: 'attributed',
              kidId: 'kid-one',
              confidence: 'definite',
              method: 'account-rule',
              explanation: 'Matched account',
              reviewStatus: 'not-required',
              reasons: [],
              decisionSource: 'automated',
              policyVersion: 7,
              engineVersion: '2.0.0',
              evaluatedAt: '2026-08-30T12:10:30.000Z',
            },
          },
        ],
      });
      expect(await harness.transaction('attribution')).toMatchObject({
        assignedKidId: null,
        kidAssignmentMethod: 'manual',
        manualDecisionAction: 'parent-expense',
        attributionStatus: 'unassigned',
      });
      expect(await harness.transaction('automated-attribution')).toMatchObject({
        assignedKidId: 'kid-one',
        kidAssignmentMethod: 'account-rule',
        manualDecisionAction: null,
        attributionStatus: 'attributed',
        attributionReasons: [],
        attributionRetryable: false,
      });

      const manualRows = await harness.repositories.attribution.readRows(
        CONNECTOR_ID,
        ['attribution'],
      );
      const manual = manualRows.get('attribution')!;
      await harness.setManualDecision({
        upstreamId: 'attribution',
        action: 'parent-expense',
        kidId: null,
        decidedAt: '2026-08-30T12:12:00.000Z',
      });
      await harness.repositories.attribution.persistUnavailable({
        connectorId: CONNECTOR_ID,
        generationId: 'attribution-generation',
        now: '2026-08-30T12:13:00.000Z',
        contractVersion: '2.0',
        provenance: 'contract-test',
        failure: {
          code: 'policy_unavailable',
          retryable: true,
          reason: 'policy-unavailable',
          explanation: 'Policy unavailable',
        },
        items: [{
          transactionId: manual.id,
          sourceFingerprint: manual.sourceFingerprint,
          sourceRef: null,
          stateSnapshot: attributionSnapshot(manual),
        }],
      });
      expect(await harness.attributionException('attribution')).toBeNull();
      expect(await harness.transaction('attribution')).toMatchObject({
        manualDecidedAt: '2026-08-30T12:12:00.000Z',
        attributionStatus: 'unassigned',
        attributionRetryable: false,
      });
    });

    it('finishes attribution against both running and completed snapshot generations', async () => {
      await harness.repositories.snapshots.start(startInput('running-attribution'));
      await expect(harness.repositories.attribution.finish({
        connectorId: CONNECTOR_ID,
        generationId: 'running-attribution',
        attemptedAt: '2026-08-30T12:30:00.000Z',
        succeeded: false,
        terminalFailureCode: 'policy_unavailable',
        status: 'unavailable',
        policyVersion: null,
        engineVersion: '2.0.0',
      })).resolves.toEqual({ recorded: true });

      await harness.repositories.snapshots.start(startInput(
        'completed-attribution',
        '2026-08-30T12:31:00.000Z',
      ));
      await harness.repositories.snapshots.complete(completeInput('completed-attribution'));
      await expect(harness.repositories.attribution.finish({
        connectorId: CONNECTOR_ID,
        generationId: 'completed-attribution',
        attemptedAt: '2026-08-30T12:32:00.000Z',
        succeeded: true,
        terminalFailureCode: null,
        status: 'healthy',
        policyVersion: 7,
        engineVersion: '2.0.0',
      })).resolves.toEqual({ recorded: true });
      await expect(harness.repositories.attribution.finish({
        connectorId: CONNECTOR_ID,
        generationId: 'superseded-attribution',
        attemptedAt: '2026-08-30T12:33:00.000Z',
        succeeded: true,
        terminalFailureCode: null,
        status: 'healthy',
        policyVersion: 7,
        engineVersion: '2.0.0',
      })).resolves.toEqual({ recorded: false });
    });

    it('fences backfill attribution against the transaction row generation', async () => {
      const generationId = 'backfill-row-generation';
      await harness.repositories.snapshots.start(startInput(generationId));
      await harness.repositories.snapshots.upsertPage(pageInput(
        generationId,
        [snapshotTransaction('backfill-attribution')],
      ));
      await harness.repositories.snapshots.complete(completeInput(generationId));
      const row = (await harness.repositories.attribution.readRows(
        CONNECTOR_ID,
        ['backfill-attribution'],
      )).get('backfill-attribution')!;
      const command = {
        connectorId: CONNECTOR_ID,
        generationId,
        fenceMode: 'row-generation' as const,
        now: '2026-08-30T12:34:00.000Z',
        contractVersion: '2.0',
        provenance: 'contract-test',
        failure: {
          code: 'policy_unavailable',
          retryable: true,
          reason: 'policy-unavailable',
          explanation: 'Policy unavailable',
        },
        items: [{
          transactionId: row.id,
          sourceFingerprint: row.sourceFingerprint,
          sourceRef: null,
          stateSnapshot: attributionSnapshot(row),
        }],
      };

      await expect(harness.repositories.attribution.persistUnavailable(command))
        .resolves.toBeUndefined();
      expect(await harness.transaction('backfill-attribution')).toMatchObject({
        attributionStatus: 'unavailable',
      });
      await expect(harness.repositories.attribution.persistUnavailable({
        ...command,
        generationId: 'superseded-backfill-row-generation',
      })).rejects.toThrow();
      await expect(harness.repositories.attribution.finish({
        connectorId: CONNECTOR_ID,
        generationId,
        fenceMode: 'row-generation',
        attemptedAt: '2026-08-30T12:35:00.000Z',
        succeeded: false,
        terminalFailureCode: 'policy_unavailable',
        status: 'unavailable',
        policyVersion: null,
        engineVersion: '2.0.0',
      })).resolves.toEqual({ recorded: true });
    });

    it('deduplicates unavailable exceptions and enforces bounded batches', async () => {
      await harness.repositories.snapshots.start(startInput('unavailable-generation'));
      await harness.repositories.snapshots.upsertPage(pageInput(
        'unavailable-generation',
        [snapshotTransaction('unavailable')],
      ));
      const row = (await harness.repositories.attribution.readRows(
        CONNECTOR_ID,
        ['unavailable'],
      )).get('unavailable')!;
      const command = {
        connectorId: CONNECTOR_ID,
        generationId: 'unavailable-generation',
        now: '2026-08-30T12:15:00.000Z',
        contractVersion: '2.0',
        provenance: 'contract-test',
        failure: {
          code: 'policy_unavailable',
          retryable: true,
          reason: 'policy-unavailable',
          explanation: 'Policy unavailable',
        },
        items: [{
          transactionId: row.id,
          sourceFingerprint: row.sourceFingerprint,
          sourceRef: null,
          stateSnapshot: attributionSnapshot(row),
        }],
      };
      await harness.repositories.attribution.persistUnavailable(command);
      await harness.repositories.attribution.persistUnavailable(command);
      expect(await harness.attributionException('unavailable')).toEqual({
        occurrenceCount: 2,
        status: 'open',
      });
      expect(await harness.transaction('unavailable')).toMatchObject({
        attributionStatus: 'unavailable',
        attributionReasons: ['policy-unavailable'],
        attributionRetryable: true,
      });

      await expect(harness.repositories.attribution.readRows(
        CONNECTOR_ID,
        Array.from({ length: 501 }, (_, index) => `transaction-${index}`),
      )).rejects.toThrow('maximum batch size');
      await expect(harness.repositories.snapshots.upsertPage(pageInput(
        'unavailable-generation',
        Array.from({ length: 501 }, (_, index) => snapshotTransaction(`item-${index}`)),
      ))).rejects.toThrow('maximum batch size');
    });

    /**
     * L12b: the API-shaped attribution mutations. Every validation, CAS, and
     * idempotency decision must happen inside the adapter's own write
     * transaction, identically on both backends.
     */
    describe('API-shaped attribution mutations', () => {
      const GENERATION = 'attribution-api-generation';

      async function seedException(): Promise<{
        transactionId: string;
        exceptionId: string;
      }> {
        await harness.repositories.snapshots.start(startInput(GENERATION));
        await harness.repositories.snapshots.upsertPage(pageInput(
          GENERATION,
          [snapshotTransaction('api-attribution')],
        ));
        const rows = await harness.repositories.attribution.readRows(
          CONNECTOR_ID,
          ['api-attribution'],
        );
        const row = rows.get('api-attribution')!;
        // Creates the projected subject the manual decision must validate against.
        await harness.repositories.attribution.applyResults({
          connectorId: CONNECTOR_ID,
          generationId: GENERATION,
          now: '2026-08-30T12:20:00.000Z',
          provenance: 'contract-test',
          items: [{
            transactionId: row.id,
            sourceFingerprint: row.sourceFingerprint,
            sourceRef: 'transaction-v1:api',
            stateSnapshot: attributionSnapshot(row),
            hasManualDecision: false,
            manualResultMatches: true,
            result: {
              contractVersion: '2.0',
              sourceRef: 'transaction-v1:api',
              status: 'pending',
              kidId: 'kid-one',
              confidence: 'likely',
              method: 'merchant-rule',
              explanation: 'Needs review',
              reviewStatus: 'pending',
              reasons: ['low-confidence'],
              decisionSource: 'automated',
              policyVersion: 7,
              engineVersion: '2.0.0',
              evaluatedAt: '2026-08-30T12:19:00.000Z',
            },
          }],
        });
        await expect(harness.repositories.attribution.finish({
          connectorId: CONNECTOR_ID,
          generationId: GENERATION,
          attemptedAt: '2026-08-30T12:21:00.000Z',
          succeeded: true,
          terminalFailureCode: null,
          status: 'healthy',
          policyVersion: 7,
          engineVersion: '2.0.0',
        })).resolves.toEqual({ recorded: true });
        const page = await harness.repositories.attribution.listExceptions({
          connectorId: CONNECTOR_ID,
          status: 'current',
          limit: 50,
          cursor: null,
        });
        return { transactionId: row.id, exceptionId: page.exceptions[0]!.id };
      }

      it('lists only public exception fields with bounded cursor pagination', async () => {
        const { exceptionId } = await seedException();
        const page = await harness.repositories.attribution.listExceptions({
          connectorId: CONNECTOR_ID,
          status: 'current',
          limit: 1,
          cursor: null,
        });

        expect(page.hasMore).toBe(false);
        expect(page.exceptions).toHaveLength(1);
        expect(page.exceptions[0]).toMatchObject({
          id: exceptionId,
          reasonCode: 'low-confidence',
          retryable: false,
          reasons: ['low-confidence'],
        });
        expect(page.exceptions[0]).not.toHaveProperty('transactionId');
        expect(page.exceptions[0]).not.toHaveProperty('sourceFingerprint');
        expect(page.subjects).toEqual([
          expect.objectContaining({ kidId: 'kid-one' }),
        ]);

        // A cursor past the only row returns an empty page, not an error.
        const empty = await harness.repositories.attribution.listExceptions({
          connectorId: CONNECTOR_ID,
          status: 'current',
          limit: 1,
          cursor: { updatedAt: '2000-01-01T00:00:00.000Z', id: 'a' },
        });
        expect(empty.exceptions).toEqual([]);
        expect(empty.hasMore).toBe(false);
      });

      it('rejects an unknown connector for every API-shaped operation', async () => {
        await expect(harness.repositories.attribution.listExceptions({
          connectorId: 'connector-absent',
          status: 'all',
          limit: 10,
          cursor: null,
        })).rejects.toMatchObject({ code: 'connector_not_found', status: 404 });
      });

      it('commits a manual decision once and replays it exactly', async () => {
        const { transactionId } = await seedException();
        const command = {
          connectorId: CONNECTOR_ID,
          transactionId,
          action: 'assign-kid' as const,
          kidId: 'kid-one',
          idempotencyKey: 'contract-manual-0001',
          auditAction: 'manual-resolve' as const,
          actorType: 'service' as const,
          exceptionId: null,
          expectedExceptionUpdatedAt: null,
          expectedTransactionVersion: null,
          now: '2026-08-30T12:30:00.000Z',
        };

        await expect(harness.repositories.attribution.applyManualDecision(command))
          .resolves.toMatchObject({ status: 'resolved', replayed: false });
        await expect(harness.repositories.attribution.applyManualDecision(command))
          .resolves.toMatchObject({ status: 'resolved', replayed: true });
        expect(await harness.transaction('api-attribution')).toMatchObject({
          assignedKidId: 'kid-one',
          kidAssignmentMethod: 'manual',
          manualDecisionAction: 'assign-kid',
        });

        // Same key, different payload is a conflict, not a silent second write.
        await expect(harness.repositories.attribution.applyManualDecision({
          ...command,
          action: 'parent-expense',
          kidId: null,
        })).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
      });

      it('validates decision shape, transaction existence, and projected subjects', async () => {
        const { transactionId } = await seedException();
        const base = {
          connectorId: CONNECTOR_ID,
          transactionId,
          idempotencyKey: 'contract-manual-0002',
          auditAction: 'manual-resolve' as const,
          actorType: 'service' as const,
          exceptionId: null,
          expectedExceptionUpdatedAt: null,
          expectedTransactionVersion: null,
          now: '2026-08-30T12:31:00.000Z',
        };

        await expect(harness.repositories.attribution.applyManualDecision({
          ...base,
          action: 'parent-expense',
          kidId: 'kid-one',
        })).rejects.toMatchObject({ code: 'invalid_manual_decision', status: 400 });
        await expect(harness.repositories.attribution.applyManualDecision({
          ...base,
          action: 'assign-kid',
          kidId: null,
        })).rejects.toMatchObject({ code: 'invalid_manual_decision', status: 400 });
        await expect(harness.repositories.attribution.applyManualDecision({
          ...base,
          action: 'assign-kid',
          kidId: 'kid-unknown',
        })).rejects.toMatchObject({ code: 'unknown_attribution_subject', status: 409 });
        await expect(harness.repositories.attribution.applyManualDecision({
          ...base,
          transactionId: 'transaction-absent',
          action: 'parent-expense',
          kidId: null,
        })).rejects.toMatchObject({ code: 'transaction_not_found', status: 404 });
      });

      it('enforces exception CAS, action legality, and after-commit retry signalling', async () => {
        const { exceptionId } = await seedException();
        const page = await harness.repositories.attribution.listExceptions({
          connectorId: CONNECTOR_ID,
          status: 'current',
          limit: 10,
          cursor: null,
        });
        const expectedUpdatedAt = page.exceptions[0]!.updatedAt;

        await expect(harness.repositories.attribution.actOnException({
          connectorId: CONNECTOR_ID,
          exceptionId,
          action: 'dismiss',
          kidId: null,
          expectedUpdatedAt: '1999-01-01T00:00:00.000Z',
          idempotencyKey: 'contract-action-stale',
          actorType: 'service',
          now: '2026-08-30T12:40:00.000Z',
        })).rejects.toMatchObject({ code: 'exception_conflict', status: 409 });

        // The seeded exception is not retryable, so a retry is a stable 409.
        await expect(harness.repositories.attribution.actOnException({
          connectorId: CONNECTOR_ID,
          exceptionId,
          action: 'retry',
          kidId: null,
          expectedUpdatedAt,
          idempotencyKey: 'contract-action-retry',
          actorType: 'service',
          now: '2026-08-30T12:41:00.000Z',
        })).rejects.toMatchObject({ code: 'exception_not_retryable', status: 409 });

        await expect(harness.repositories.attribution.actOnException({
          connectorId: CONNECTOR_ID,
          exceptionId: 'exception-absent',
          action: 'dismiss',
          kidId: null,
          expectedUpdatedAt,
          idempotencyKey: 'contract-action-missing',
          actorType: 'service',
          now: '2026-08-30T12:42:00.000Z',
        })).rejects.toMatchObject({ code: 'exception_not_found', status: 404 });

        const dismissCommand = {
          connectorId: CONNECTOR_ID,
          exceptionId,
          action: 'dismiss' as const,
          kidId: null,
          expectedUpdatedAt,
          idempotencyKey: 'contract-action-dismiss',
          actorType: 'service' as const,
          now: '2026-08-30T12:43:00.000Z',
        };
        await expect(harness.repositories.attribution.actOnException(dismissCommand))
          .resolves.toMatchObject({
            status: 'dismissed',
            replayed: false,
            retryScheduled: false,
          });
        await expect(harness.repositories.attribution.actOnException(dismissCommand))
          .resolves.toMatchObject({
            status: 'dismissed',
            replayed: true,
            retryScheduled: false,
          });
        expect(await harness.attributionException('api-attribution'))
          .toMatchObject({ status: 'dismissed' });
      });
    });
  });
}

export { BASE_TIME, CONNECTOR_ID };
