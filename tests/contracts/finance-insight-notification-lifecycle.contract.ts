import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  FinanceInsightNotificationIngestItem,
  FinanceInsightNotificationLifecyclePersistence,
  FinanceInsightNotificationReconcileItem,
} from '@/db/persistence/finance-insights';

/**
 * Shared SQLite/PostgreSQL contract for `FinanceInsightPersistence.notifications`
 * (the portable `runLifecycle` port backing the migrated
 * `src/lib/finance-insights/notification-ingestion.ts` path). Mirrors the
 * style of `finance-attention-persistence.contract.ts`: one adapter-owned
 * transaction that must reconcile no-longer-eligible occurrences, create/
 * dedupe eligible ones by `sourceId`, resync provider presentation/actions,
 * and report an accurate outbox pending-delivery flag — identically on both
 * backends.
 */

export const CONNECTOR_ID = 'finance-insight-notification-contract';
export const BASE_TIME = '2026-09-01T12:00:00.000Z';

/** A fixed occurrence id reserved for the rollback/atomicity test: wiring
 * files install a trigger that aborts the `notifications` INSERT for this
 * occurrence's sourceId so a multi-item `runLifecycle` call can be forced to
 * fail partway through. */
export const POISON_OCCURRENCE_ID = 'contract-induced-poison';

export function financeInsightContractSourceId(occurrenceId: string): string {
  return `finance-insight:${CONNECTOR_ID}:${occurrenceId}`;
}

export interface FinanceInsightNotificationIngestFixtureInput {
  occurrenceId?: string;
  insightId?: string;
  deliveryRevision?: number;
  title?: string;
  body?: string | null;
  level?: string;
  templateKey?: string;
  notificationType?: string;
  sourceState?: 'active' | 'resolved';
}

/**
 * Builds one `FinanceInsightNotificationIngestItem` matching the exact shape
 * `src/lib/finance-insights/notification-ingestion.ts` produces in
 * production (same `sourceId`/`groupKey`/`dedupeKey`/`occurrenceKey`
 * derivation, same `finance-insight-largeTransaction` templateKey/metadata
 * so the registered finance notification provider resolves presentation and
 * a navigate action deterministically), but built directly against the
 * portable port instead of going through `InsightOccurrenceSummaryV1` so the
 * contract stays decoupled from that lib-specific type.
 */
export function financeInsightIngestItem(
  input: FinanceInsightNotificationIngestFixtureInput = {},
): FinanceInsightNotificationIngestItem {
  const occurrenceId = input.occurrenceId ?? 'occurrence-1';
  const insightId = input.insightId ?? 'insight-1';
  const deliveryRevision = input.deliveryRevision ?? 1;
  const sourceId = financeInsightContractSourceId(occurrenceId);
  const occurrenceKey = `${occurrenceId}:${deliveryRevision}`;
  const sourceState = input.sourceState ?? 'active';
  return {
    input: {
      id: randomUUID(),
      sourceId,
      connectorType: 'finance-manager',
      connectorInstanceId: CONNECTOR_ID,
      title: input.title ?? 'Unusually large transaction detected',
      body: input.body ?? 'A transaction was larger than expected.',
      level: input.level ?? 'action_needed',
      category: 'finance',
      templateKey: input.templateKey ?? 'finance-insight-largeTransaction',
      readState: 'unread',
      sourceState,
      sourceActivityAt: BASE_TIME,
      sourceActivityKey: occurrenceKey,
      reopenPolicy: 'handled_and_dismissed',
      occurrenceKey,
      isActionable: sourceState === 'active',
      primaryActionId: null,
      receivedAt: BASE_TIME,
      sortAt: BASE_TIME,
      relatedTaskId: null,
      relatedProjectId: null,
      relatedEntityType: 'finance-insight-occurrence',
      relatedEntityId: occurrenceId,
      navigationTarget: null,
      metadata: {
        notificationType: input.notificationType ?? 'largeTransaction',
        occurrenceId,
        insightId,
        entityDisplayName: 'Test Merchant',
        currency: 'USD',
        observedAmountMinor: 250_000,
      },
      presentation: {},
    },
    groupKey: `finance-insight:${CONNECTOR_ID}:${insightId}`,
    dedupeKey: sourceId,
  };
}

export function financeInsightReconcileItem(
  sourceId: string,
  overrides: Partial<FinanceInsightNotificationReconcileItem> = {},
): FinanceInsightNotificationReconcileItem {
  return {
    sourceId,
    lastSourceActivityAt: BASE_TIME,
    lastSourceActivityKey: 'resolved:1',
    sourceResolvedAt: BASE_TIME,
    metadata: { notificationType: 'largeTransaction', sourceLifecycle: 'resolved' },
    ...overrides,
  };
}

export interface FinanceInsightNotificationSnapshot {
  id: string;
  sourceId: string;
  title: string;
  body: string | null;
  state: string;
  sourceState: string;
  isActionable: boolean;
  primaryActionId: string | null;
  groupKey: string | null;
  dedupeKey: string | null;
}

export interface FinanceInsightNotificationLifecycleContractHarness {
  notifications: FinanceInsightNotificationLifecyclePersistence;
  reset(): Promise<void>;
  seedConnector(): Promise<void>;
  notificationBySourceId(sourceId: string): Promise<FinanceInsightNotificationSnapshot | null>;
  countNotifications(): Promise<number>;
  actionCount(notificationId: string): Promise<number>;
  deliveryEventCount(notificationId: string): Promise<number>;
  pendingDeliveryCount(notificationId: string): Promise<number>;
  setGlobalPushEnabled(enabled: boolean): Promise<void>;
  /** Parsed `payload_snapshot.title` for every delivery event row belonging
   * to the notification, used to assert the outbox never carries an
   * unredacted secret-looking title even though the stored notification row
   * itself keeps the raw source-of-truth text. */
  deliveryPayloadTitles(notificationId: string): Promise<string[]>;
  /** Installs a trigger that aborts the `notifications` INSERT for
   * `financeInsightContractSourceId(POISON_OCCURRENCE_ID)` so a multi-item
   * `runLifecycle` call can be forced to fail partway through, proving the
   * whole call (reconcile + every ingest item) is one atomic transaction. */
  installIngestAbortTrigger(): Promise<void>;
  removeIngestAbortTrigger(): Promise<void>;
}

export function describeFinanceInsightNotificationLifecycleContract(
  label: string,
  createHarness: () => Promise<FinanceInsightNotificationLifecycleContractHarness>,
): void {
  describe(`${label} finance insight notification lifecycle contract`, () => {
    let harness: FinanceInsightNotificationLifecycleContractHarness;

    beforeEach(async () => {
      harness ??= await createHarness();
      await harness.reset();
      await harness.seedConnector();
    });

    describe('create + outbox', () => {
      it('creates a new active notification with a pending outbox delivery, group/dedupe keys, and provider-resolved actions', async () => {
        const item = financeInsightIngestItem();

        const outcome = await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [],
          ingest: [item],
        });

        expect(outcome.results).toHaveLength(1);
        expect(outcome.results[0]).toMatchObject({ created: true });
        expect(outcome.hasPendingDelivery).toBe(true);

        const notification = await harness.notificationBySourceId(item.input.sourceId);
        expect(notification).toMatchObject({
          sourceState: 'active',
          isActionable: true,
          groupKey: item.groupKey,
          dedupeKey: item.dedupeKey,
        });
        expect(notification!.primaryActionId).not.toBeNull();
        expect(await harness.actionCount(notification!.id)).toBeGreaterThan(0);
        expect(await harness.pendingDeliveryCount(notification!.id)).toBeGreaterThan(0);
        expect(await harness.countNotifications()).toBe(1);
      });

      it('persists suppressed outbox rows without waking delivery when global push is disabled', async () => {
        await harness.setGlobalPushEnabled(false);
        const item = financeInsightIngestItem({ occurrenceId: 'occurrence-push-disabled' });

        const outcome = await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [],
          ingest: [item],
        });

        const notification = await harness.notificationBySourceId(item.input.sourceId);
        expect(notification).not.toBeNull();
        expect(outcome.hasPendingDelivery).toBe(false);
        expect(await harness.deliveryEventCount(notification!.id)).toBeGreaterThan(0);
        expect(await harness.pendingDeliveryCount(notification!.id)).toBe(0);
      });
    });

    describe('dedupe', () => {
      it('dedupes a repeated ingest for the same occurrence without creating a duplicate row or a duplicate delivery event', async () => {
        const item = financeInsightIngestItem({ occurrenceId: 'occurrence-dedupe' });
        await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [],
          ingest: [item],
        });
        const notification = await harness.notificationBySourceId(item.input.sourceId);
        const deliveryCountAfterCreate = await harness.deliveryEventCount(notification!.id);
        expect(deliveryCountAfterCreate).toBeGreaterThan(0);

        const replay = await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [],
          ingest: [item],
        });

        expect(replay.results).toHaveLength(1);
        expect(replay.results[0]).toMatchObject({ created: false });
        expect(await harness.countNotifications()).toBe(1);
        // The dedupe key on the delivery event (`channel:notificationId:occurrenceKey`)
        // must prevent a second outbox row from ever being written for an
        // unchanged occurrence, on both backends.
        expect(await harness.deliveryEventCount(notification!.id)).toBe(deliveryCountAfterCreate);
      });

      it('groups multiple occurrence notifications from one insight under a shared groupKey while keeping distinct dedupeKeys', async () => {
        const first = financeInsightIngestItem({ occurrenceId: 'occurrence-a', insightId: 'insight-shared' });
        const second = financeInsightIngestItem({ occurrenceId: 'occurrence-b', insightId: 'insight-shared' });

        await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [],
          ingest: [first, second],
        });

        const notificationA = await harness.notificationBySourceId(first.input.sourceId);
        const notificationB = await harness.notificationBySourceId(second.input.sourceId);
        expect(notificationA).not.toBeNull();
        expect(notificationB).not.toBeNull();
        expect(notificationA!.groupKey).toBe(notificationB!.groupKey);
        expect(notificationA!.groupKey).toBe(first.groupKey);
        expect(notificationA!.dedupeKey).not.toBe(notificationB!.dedupeKey);
        expect(await harness.countNotifications()).toBe(2);
      });
    });

    describe('lifecycle', () => {
      it('closes out a reconciled occurrence and creates a successor in the same atomic pass', async () => {
        const original = financeInsightIngestItem({ occurrenceId: 'occurrence-closing' });
        await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [],
          ingest: [original],
        });
        const before = await harness.notificationBySourceId(original.input.sourceId);
        expect(before).toMatchObject({ sourceState: 'active', isActionable: true });
        expect(await harness.actionCount(before!.id)).toBeGreaterThan(0);

        const successor = financeInsightIngestItem({ occurrenceId: 'occurrence-successor' });
        const outcome = await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [financeInsightReconcileItem(original.input.sourceId)],
          ingest: [successor],
        });

        const closed = await harness.notificationBySourceId(original.input.sourceId);
        expect(closed).toMatchObject({
          sourceState: 'resolved',
          isActionable: false,
          primaryActionId: null,
        });
        expect(await harness.actionCount(closed!.id)).toBe(0);

        const created = await harness.notificationBySourceId(successor.input.sourceId);
        expect(created).toMatchObject({ sourceState: 'active', isActionable: true });
        expect(outcome.results.map((result) => result.id)).toContain(created!.id);
        expect(await harness.countNotifications()).toBe(2);
      });
    });

    describe('rollback / atomicity', () => {
      it('rolls back reconcile and ingest writes from the same call when one ingest item fails', async () => {
        const survivor = financeInsightIngestItem({ occurrenceId: 'occurrence-rollback-target' });
        await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [],
          ingest: [survivor],
        });
        const countBeforeAttempt = await harness.countNotifications();

        await harness.installIngestAbortTrigger();
        try {
          const valid = financeInsightIngestItem({ occurrenceId: 'occurrence-rollback-valid' });
          const poison = financeInsightIngestItem({ occurrenceId: POISON_OCCURRENCE_ID });
          await expect(
            harness.notifications.runLifecycle({
              connectorId: CONNECTOR_ID,
              now: BASE_TIME,
              reconcile: [financeInsightReconcileItem(survivor.input.sourceId)],
              ingest: [valid, poison],
            }),
          ).rejects.toThrow();
        } finally {
          await harness.removeIngestAbortTrigger();
        }

        // Neither the reconcile-side close-out nor the valid ingest item's
        // create survives: one adapter-owned transaction, not per-item commits.
        expect(await harness.countNotifications()).toBe(countBeforeAttempt);
        const stillOpen = await harness.notificationBySourceId(survivor.input.sourceId);
        expect(stillOpen).toMatchObject({ sourceState: 'active', isActionable: true });
        const notCreated = await harness.notificationBySourceId(
          financeInsightContractSourceId('occurrence-rollback-valid'),
        );
        expect(notCreated).toBeNull();
      });
    });

    describe('sensitive-data-safe outbox', () => {
      it('never writes an unredacted secret-looking title into an outbox delivery payload snapshot', async () => {
        const secret = 'sk-test-abc123XYZ';
        const item = financeInsightIngestItem({
          occurrenceId: 'occurrence-secret',
          title: `Reconnect required: Authorization: Bearer ${secret}`,
        });

        await harness.notifications.runLifecycle({
          connectorId: CONNECTOR_ID,
          now: BASE_TIME,
          reconcile: [],
          ingest: [item],
        });

        const notification = await harness.notificationBySourceId(item.input.sourceId);
        const payloadTitles = await harness.deliveryPayloadTitles(notification!.id);
        expect(payloadTitles.length).toBeGreaterThan(0);
        for (const payloadTitle of payloadTitles) {
          expect(payloadTitle).not.toContain(secret);
        }
      });
    });
  });
}
