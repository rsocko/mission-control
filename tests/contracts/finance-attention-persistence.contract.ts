import { beforeEach, describe, expect, it } from 'vitest';
import type {
  FinanceAttentionRepairPersistence,
  FinanceAttentionRoutingPersistence,
} from '@/db/persistence/finance-attention';
import {
  FINANCE_ATTENTION_REPAIR_CONFIRMATION,
  FINANCE_ATTENTION_REPAIR_CUTOVER,
  FINANCE_ATTENTION_REPAIR_REASON,
  FINANCE_ATTENTION_REPAIR_WINDOW_START,
  FINANCE_MY_DAY_DAILY_CAP,
  FINANCE_TASK_PROMOTION_DAILY_CAP,
  financeAttentionSourceId,
  financeAttentionTaskId,
} from '@/db/persistence/finance-attention';

export const CONNECTOR_ID = 'finance-attention-contract';
export const BASE_TIME = '2026-08-11T12:00:00.000Z';
const BASE = new Date(BASE_TIME);

export function iso(hoursAgo: number, from: Date = BASE): string {
  return new Date(from.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
}

export interface FinanceAttentionNotificationSnapshot {
  id: string;
  state: string;
  sourceState: string;
  isActionable: boolean;
  primaryActionId: string | null;
  autoResolveReason: string | null;
  relatedTaskId: string | null;
}

export interface FinanceAttentionTaskSnapshot {
  id: string;
  status: string;
  localDisposition: string;
  statusReason: string | null;
}

export interface FinanceAttentionContractHarness {
  routing: FinanceAttentionRoutingPersistence;
  repair: FinanceAttentionRepairPersistence;
  reset(): Promise<void>;
  seedConnector(input?: { enabled?: boolean }): Promise<void>;
  seedAttributionException(input: {
    id: string;
    status?: 'open' | 'retry_requested' | 'resolved' | 'dismissed';
    reviewState?: 'pending' | 'resolved';
    reasonCode?: string;
    retryable?: boolean;
    firstObservedAt: string;
    lastObservedAt: string;
    updatedAt?: string;
  }): Promise<void>;
  seedWriteBackAudit(input: {
    id: string;
    status?: 'pending' | 'processing' | 'succeeded' | 'failed';
    attemptCount?: number;
    updatedAt: string;
  }): Promise<void>;
  notificationBySourceId(sourceId: string): Promise<FinanceAttentionNotificationSnapshot | null>;
  deliveryEventCount(notificationId: string): Promise<number>;
  pendingDeliveryCount(notificationId: string): Promise<number>;
  taskBySourceId(sourceId: string): Promise<FinanceAttentionTaskSnapshot | null>;
  countNotifications(): Promise<number>;
  countTasks(): Promise<number>;
  myDayTaskIds(date: string): Promise<string[]>;
  /** Seeds one exception plus its projected notification/action/delivery/task/My-Day
   * row inside the `attribution_not_configured` repair window, matching the shape
   * `repairAttributionNotConfiguredAttention` targets. */
  seedRepairProjection(input: { exceptionId: string; withTask?: boolean }): Promise<void>;
  markDeliveryInFlight(exceptionId: string): Promise<void>;
  repairAuditCount(): Promise<number>;
  /** Installs a trigger that aborts the write that sets a notification's
   * `auto_resolve_reason` to `status_only` — the update every repair apply
   * issues — so atomicity/rollback can be exercised on both backends. */
  installRepairAbortTrigger(): Promise<void>;
  removeRepairAbortTrigger(): Promise<void>;
}

export function describeFinanceAttentionPersistenceContract(
  label: string,
  createHarness: () => Promise<FinanceAttentionContractHarness>,
): void {
  describe(`${label} finance attention persistence contract`, () => {
    let harness: FinanceAttentionContractHarness;

    beforeEach(async () => {
      harness ??= await createHarness();
      await harness.reset();
      await harness.seedConnector();
    });

    describe('routing', () => {
      it('creates one notification with a pending outbox delivery, then dedupes on replay', async () => {
        await harness.seedAttributionException({
          id: 'exception-fresh',
          firstObservedAt: iso(2),
          lastObservedAt: iso(2),
        });
        const signal = {
          connectorId: CONNECTOR_ID,
          signalKind: 'attributionReviewRequired' as const,
          sourceRef: 'exception-fresh',
        };
        const sourceId = financeAttentionSourceId(signal);

        const first = await harness.routing.reconcile({
          connectorId: CONNECTOR_ID,
          decisionAt: BASE,
        });
        expect(first.summary).toMatchObject({
          evaluated: 1,
          notificationsCreated: 1,
          tasksCreated: 0,
        });
        const notification = await harness.notificationBySourceId(sourceId);
        expect(notification).toMatchObject({
          sourceState: 'active',
          isActionable: true,
        });
        // The adapter's `hasPendingDelivery` flag must always agree with the
        // outbox it just wrote — whether the generic push-policy/catalog
        // actually admits this template for delivery is that system's own
        // concern, not this adapter's.
        const deliveryCountAfterCreate = await harness.deliveryEventCount(notification!.id);
        expect(deliveryCountAfterCreate).toBeGreaterThan(0);
        const pendingAfterCreate = await harness.pendingDeliveryCount(notification!.id);
        expect(first.hasPendingDelivery).toBe(pendingAfterCreate > 0);
        expect(await harness.countNotifications()).toBe(1);

        const replay = await harness.routing.reconcile({
          connectorId: CONNECTOR_ID,
          decisionAt: BASE,
        });
        expect(replay.summary).toMatchObject({
          evaluated: 1,
          notificationsCreated: 0,
        });
        // A replay of an unchanged signal must never re-fire the outbox: no
        // new delivery event row, and the pending-delivery flag stays false
        // even if the first create did leave a pending row outstanding.
        expect(replay.hasPendingDelivery).toBe(false);
        expect(await harness.countNotifications()).toBe(1);
        expect(await harness.deliveryEventCount(notification!.id)).toBe(deliveryCountAfterCreate);
      });

      it('settles the notification into a task once escalation promotes it, updating relatedTaskId', async () => {
        await harness.seedAttributionException({
          id: 'exception-escalating',
          firstObservedAt: iso(2),
          lastObservedAt: iso(2),
        });
        const signal = {
          connectorId: CONNECTOR_ID,
          signalKind: 'attributionReviewRequired' as const,
          sourceRef: 'exception-escalating',
        };
        const sourceId = financeAttentionSourceId(signal);
        await harness.routing.reconcile({ connectorId: CONNECTOR_ID, decisionAt: BASE });

        await harness.seedAttributionException({
          id: 'exception-escalating',
          firstObservedAt: iso(25),
          lastObservedAt: iso(1),
        });
        const escalated = await harness.routing.reconcile({
          connectorId: CONNECTOR_ID,
          decisionAt: BASE,
        });
        expect(escalated.summary).toMatchObject({ tasksCreated: 1, taskPromoted: 1 });

        const notification = await harness.notificationBySourceId(sourceId);
        const task = await harness.taskBySourceId(sourceId);
        expect(notification).toMatchObject({ sourceState: 'resolved', isActionable: false });
        expect(notification!.relatedTaskId).toBe(task!.id);
      });

      it('enforces the daily promotion cap deterministically and defers the remainder', async () => {
        const seeded = FINANCE_TASK_PROMOTION_DAILY_CAP + 3;
        for (let index = 0; index < seeded; index++) {
          const id = `exception-cap-${String(index).padStart(3, '0')}`;
          // Escalated attribution (>=24h condition age) routes to 'task' but
          // never qualifies for My Day (medium priority, no due date), so the
          // promotion cap is exercised in isolation from the My Day cap.
          await harness.seedAttributionException({
            id,
            firstObservedAt: iso(48),
            lastObservedAt: iso(1, new Date(BASE.getTime() + index * 1000)),
            updatedAt: iso(1, new Date(BASE.getTime() + index * 1000)),
          });
        }

        const result = await harness.routing.reconcile({
          connectorId: CONNECTOR_ID,
          decisionAt: BASE,
        });
        expect(result.summary).toMatchObject({
          evaluated: seeded,
          tasksCreated: FINANCE_TASK_PROMOTION_DAILY_CAP,
          taskPromoted: FINANCE_TASK_PROMOTION_DAILY_CAP,
          deferred: seeded - FINANCE_TASK_PROMOTION_DAILY_CAP,
          autoIncluded: 0,
        });
        expect(await harness.countTasks()).toBe(FINANCE_TASK_PROMOTION_DAILY_CAP);

        // Every promoted task is one of the earliest-updated exceptions
        // (deterministic tie-break by conditionSince, i.e. `first_observed_at`
        // ties broken by `sourceRef`, since these all share firstObservedAt).
        for (let index = 0; index < FINANCE_TASK_PROMOTION_DAILY_CAP; index++) {
          const signal = {
            connectorId: CONNECTOR_ID,
            signalKind: 'attributionReviewRequired' as const,
            sourceRef: `exception-cap-${String(index).padStart(3, '0')}`,
          };
          expect(await harness.taskBySourceId(financeAttentionSourceId(signal))).not.toBeNull();
        }
        for (let index = FINANCE_TASK_PROMOTION_DAILY_CAP; index < seeded; index++) {
          const signal = {
            connectorId: CONNECTOR_ID,
            signalKind: 'attributionReviewRequired' as const,
            sourceRef: `exception-cap-${String(index).padStart(3, '0')}`,
          };
          expect(await harness.taskBySourceId(financeAttentionSourceId(signal))).toBeNull();
        }
      });

      it('caps My Day at the daily limit with deterministic auto-inclusion order', async () => {
        const seeded = FINANCE_MY_DAY_DAILY_CAP + 2;
        for (let index = 0; index < seeded; index++) {
          const id = `audit-myday-${String(index).padStart(3, '0')}`;
          // Distinct `updated_at` values give a deterministic conditionSince
          // tie-break for both the promotion cap and the My Day ordering.
          await harness.seedWriteBackAudit({
            id,
            attemptCount: 3,
            status: 'failed',
            updatedAt: iso(1, new Date(BASE.getTime() + index * 1000)),
          });
        }

        const result = await harness.routing.reconcile({
          connectorId: CONNECTOR_ID,
          decisionAt: BASE,
        });
        expect(result.summary).toMatchObject({
          autoIncluded: FINANCE_MY_DAY_DAILY_CAP,
          deferred: seeded - FINANCE_MY_DAY_DAILY_CAP,
        });

        const date = BASE.toISOString().slice(0, 10);
        const includedTaskIds = await harness.myDayTaskIds(date);
        expect(includedTaskIds).toHaveLength(FINANCE_MY_DAY_DAILY_CAP);
        const expectedTaskIds = Array.from({ length: FINANCE_MY_DAY_DAILY_CAP }, (_, index) => (
          financeAttentionTaskId({
            connectorId: CONNECTOR_ID,
            signalKind: 'writeBackFailed' as const,
            sourceRef: `audit-myday-${String(index).padStart(3, '0')}`,
          })
        ));
        expect(new Set(includedTaskIds)).toEqual(new Set(expectedTaskIds));
      });

      it('preserves stale source state without creating or reopening attention', async () => {
        await harness.seedAttributionException({
          id: 'exception-stale',
          firstObservedAt: iso(80),
          lastObservedAt: iso(25),
        });
        const result = await harness.routing.reconcile({
          connectorId: CONNECTOR_ID,
          decisionAt: BASE,
        });
        expect(result.summary).toMatchObject({
          evaluated: 1,
          notificationsCreated: 0,
          tasksCreated: 0,
          stalePreserved: 1,
        });
        expect(await harness.countNotifications()).toBe(0);
        expect(await harness.countTasks()).toBe(0);
      });
    });

    describe('repair', () => {
      it('dry-runs the exact target set, then applies and replays idempotently', async () => {
        await harness.seedRepairProjection({ exceptionId: 'repair-affected', withTask: true });

        const dryRun = await harness.repair.repair({
          connectorId: CONNECTOR_ID,
          mode: 'dry-run',
          actorType: 'service',
          idempotencyKey: 'contract-dry-run-0001',
          dryRunId: null,
          now: BASE_TIME,
          runId: 'contract-dry-run-run-id',
        });
        expect(dryRun).toMatchObject({
          mode: 'dry-run',
          applied: false,
          replayed: false,
          counts: {
            occurrences: 1,
            notifications: 1,
            connectorActions: 1,
            pendingDeliveries: 1,
            tasks: 1,
            myDayItems: 1,
          },
        });
        expect(await harness.repairAuditCount()).toBe(1);

        const applyInput = {
          connectorId: CONNECTOR_ID,
          mode: 'apply' as const,
          actorType: 'service' as const,
          idempotencyKey: 'contract-apply-0001',
          dryRunId: dryRun.runId,
          now: BASE_TIME,
          runId: 'contract-apply-run-id',
        };
        const applied = await harness.repair.repair(applyInput);
        expect(applied).toMatchObject({ mode: 'apply', applied: true, replayed: false });
        expect(await harness.repairAuditCount()).toBe(2);

        const signal = {
          connectorId: CONNECTOR_ID,
          signalKind: 'attributionReviewRequired' as const,
          sourceRef: 'repair-affected',
        };
        const notification = await harness.notificationBySourceId(
          financeAttentionSourceId(signal),
        );
        expect(notification).toMatchObject({ sourceState: 'resolved', isActionable: false });
        const task = await harness.taskBySourceId(financeAttentionSourceId(signal));
        expect(task).toMatchObject({ status: 'cancelled', statusReason: 'not_planned' });

        const replay = await harness.repair.repair(applyInput);
        expect(replay).toMatchObject({
          runId: applied.runId,
          replayed: true,
          applied: true,
          counts: applied.counts,
        });
        expect(await harness.repairAuditCount()).toBe(2);
      });

      it('fails closed on scope drift and on an in-flight delivery, without writing', async () => {
        await harness.seedRepairProjection({ exceptionId: 'repair-fenced' });
        const dryRun = await harness.repair.repair({
          connectorId: CONNECTOR_ID,
          mode: 'dry-run',
          actorType: 'service',
          idempotencyKey: 'contract-fence-dry-0001',
          dryRunId: null,
          now: BASE_TIME,
          runId: 'contract-fence-dry-run-id',
        });

        await harness.seedRepairProjection({ exceptionId: 'repair-fenced-extra' });
        await expect(harness.repair.repair({
          connectorId: CONNECTOR_ID,
          mode: 'apply',
          actorType: 'service',
          idempotencyKey: 'contract-fence-apply-scope-0001',
          dryRunId: dryRun.runId,
          now: BASE_TIME,
          runId: 'contract-fence-apply-scope-run-id',
        })).rejects.toMatchObject({ code: 'repair_scope_changed', status: 409 });
        expect(await harness.repairAuditCount()).toBe(1);

        const secondDryRun = await harness.repair.repair({
          connectorId: CONNECTOR_ID,
          mode: 'dry-run',
          actorType: 'service',
          idempotencyKey: 'contract-fence-dry-0002',
          dryRunId: null,
          now: BASE_TIME,
          runId: 'contract-fence-dry-run-id-2',
        });
        await harness.markDeliveryInFlight('repair-fenced');
        await expect(harness.repair.repair({
          connectorId: CONNECTOR_ID,
          mode: 'apply',
          actorType: 'service',
          idempotencyKey: 'contract-fence-apply-flight-0001',
          dryRunId: secondDryRun.runId,
          now: BASE_TIME,
          runId: 'contract-fence-apply-flight-run-id',
        })).rejects.toMatchObject({ code: 'repair_delivery_in_flight', status: 409 });
        expect(await harness.repairAuditCount()).toBe(2);

        const signal = {
          connectorId: CONNECTOR_ID,
          signalKind: 'attributionReviewRequired' as const,
          sourceRef: 'repair-fenced',
        };
        const notification = await harness.notificationBySourceId(
          financeAttentionSourceId(signal),
        );
        expect(notification).toMatchObject({ sourceState: 'active', isActionable: true });
      });

      it('rolls back every projection write and the audit row when the apply write fails', async () => {
        await harness.seedRepairProjection({ exceptionId: 'repair-rollback', withTask: true });
        const dryRun = await harness.repair.repair({
          connectorId: CONNECTOR_ID,
          mode: 'dry-run',
          actorType: 'service',
          idempotencyKey: 'contract-rollback-dry-0001',
          dryRunId: null,
          now: BASE_TIME,
          runId: 'contract-rollback-dry-run-id',
        });

        await harness.installRepairAbortTrigger();
        try {
          await expect(harness.repair.repair({
            connectorId: CONNECTOR_ID,
            mode: 'apply',
            actorType: 'service',
            idempotencyKey: 'contract-rollback-apply-0001',
            dryRunId: dryRun.runId,
            now: BASE_TIME,
            runId: 'contract-rollback-apply-run-id',
          })).rejects.toBeTruthy();
        } finally {
          await harness.removeRepairAbortTrigger();
        }

        expect(await harness.repairAuditCount()).toBe(1);
        const signal = {
          connectorId: CONNECTOR_ID,
          signalKind: 'attributionReviewRequired' as const,
          sourceRef: 'repair-rollback',
        };
        const notification = await harness.notificationBySourceId(
          financeAttentionSourceId(signal),
        );
        expect(notification).toMatchObject({ sourceState: 'active', isActionable: true });
        const task = await harness.taskBySourceId(financeAttentionSourceId(signal));
        expect(task).toMatchObject({ status: 'todo' });
      });
    });
  });
}

export {
  FINANCE_ATTENTION_REPAIR_CONFIRMATION,
  FINANCE_ATTENTION_REPAIR_CUTOVER,
  FINANCE_ATTENTION_REPAIR_REASON,
  FINANCE_ATTENTION_REPAIR_WINDOW_START,
};
