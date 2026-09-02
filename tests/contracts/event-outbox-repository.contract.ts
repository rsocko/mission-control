import { describe, expect, it, beforeEach } from 'vitest';
import type {
  EventDeliveryRepositories,
  EventOutboxEnqueueRequest,
} from '@/db/persistence/event-outbox';

export const EVENT_OUTBOX_BASE_TIME = new Date('2026-02-01T00:00:00.000Z');

export interface EventOutboxContractHarness {
  repositories: EventDeliveryRepositories;
  /** Removes every event, delivery and subscription created by the contract. */
  reset(): Promise<void>;
  seedWebhook(input: {
    id: string;
    eventTypes: string[];
    url?: string;
    secret?: string | null;
    enabled?: boolean;
  }): Promise<void>;
  setWebhookEnabled(id: string, enabled: boolean): Promise<void>;
  getDelivery(id: string): Promise<{
    status: string;
    attemptCount: number;
    leaseOwner: string | null;
    leaseToken: string | null;
    nextAttemptAt: string | null;
    lastError: string | null;
    lastStatus: number | null;
  } | null>;
  listDeliveries(): Promise<Array<{ id: string; eventSequence: number; webhookId: string }>>;
  /** Replaces the stored payload with a value the backend cannot decode. */
  poisonPayload(sequence: number): Promise<void>;
}

function request(
  stableKey: string,
  overrides: Partial<EventOutboxEnqueueRequest> = {},
): EventOutboxEnqueueRequest {
  return {
    stableKey,
    eventType: 'sync.completed',
    payload: { connectorId: 'c1' },
    occurredAt: EVENT_OUTBOX_BASE_TIME.toISOString(),
    ...overrides,
  };
}

/**
 * Backend-neutral behaviour every event-outbox adapter must satisfy. Both the
 * SQLite and PostgreSQL adapters run this identical suite so a backend swap
 * cannot silently change durability, fencing or ordering semantics.
 */
export function describeEventOutboxRepositoryContract(
  label: string,
  createHarness: () => Promise<EventOutboxContractHarness>,
): void {
  describe(label, () => {
    let harness: EventOutboxContractHarness;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
    });

    it('fans an enqueued event out to matching enabled subscriptions only', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      await harness.seedWebhook({ id: 'oc-b', eventTypes: ['sync.failed'] });
      await harness.seedWebhook({
        id: 'oc-c',
        eventTypes: ['sync.completed'],
        enabled: false,
      });

      const result = await harness.repositories.outbox.enqueue(request('oc:k1'));

      expect(result.created).toBe(true);
      expect(result.deliveryCount).toBe(1);
      const deliveries = await harness.listDeliveries();
      expect(deliveries.map((entry) => entry.webhookId)).toEqual(['oc-a']);
    });

    it('deduplicates a repeated stable key', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });

      const first = await harness.repositories.outbox.enqueue(request('oc:k1'));
      const second = await harness.repositories.outbox.enqueue(request('oc:k1'));

      expect(second).toEqual({
        created: false,
        sequence: first.sequence,
        deliveryCount: 0,
      });
      expect(await harness.listDeliveries()).toHaveLength(1);
    });

    it('claims under a fenced lease and rejects the fenced-out owner', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      await harness.repositories.outbox.enqueue(request('oc:k1'));

      const stale = await harness.repositories.outbox.claimNext({
        now: EVENT_OUTBOX_BASE_TIME,
        leaseMs: 1_000,
        owner: 'owner-1',
      });
      expect(stale).not.toBeNull();
      expect(stale!.attemptCount).toBe(1);

      const recovered = await harness.repositories.outbox.claimNext({
        now: new Date(EVENT_OUTBOX_BASE_TIME.getTime() + 5_000),
        leaseMs: 60_000,
        owner: 'owner-2',
      });
      expect(recovered!.id).toBe(stale!.id);
      expect(recovered!.leaseToken).not.toBe(stale!.leaseToken);

      expect(await harness.repositories.outbox.heartbeat(stale!, 'later')).toBe(false);
      expect(await harness.repositories.outbox.markDelivered(stale!, {
        deliveredAt: EVENT_OUTBOX_BASE_TIME.toISOString(),
        lastStatus: 200,
      })).toBe(false);
      expect(await harness.repositories.outbox.scheduleRetry(stale!, {
        nextAttemptAt: EVENT_OUTBOX_BASE_TIME.toISOString(),
        lastError: 'network_error',
      })).toBe(false);
      expect(await harness.repositories.outbox.deadLetter(stale!, {
        lastError: 'network_error',
      })).toBe(false);

      expect(await harness.repositories.outbox.markDelivered(recovered!, {
        deliveredAt: EVENT_OUTBOX_BASE_TIME.toISOString(),
        lastStatus: 200,
      })).toBe(true);
      expect(await harness.getDelivery(recovered!.id)).toMatchObject({
        status: 'delivered',
        leaseOwner: null,
        leaseToken: null,
        lastStatus: 200,
      });
    });

    it('never hands one delivery to two concurrent owners', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      await harness.repositories.outbox.enqueue(request('oc:k1'));

      const [first, second] = await Promise.all([
        harness.repositories.outbox.claimNext({
          now: EVENT_OUTBOX_BASE_TIME,
          leaseMs: 60_000,
          owner: 'owner-1',
        }),
        harness.repositories.outbox.claimNext({
          now: EVENT_OUTBOX_BASE_TIME,
          leaseMs: 60_000,
          owner: 'owner-2',
        }),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
    });

    it('keeps per-webhook delivery order deterministic', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      const first = await harness.repositories.outbox.enqueue(request('oc:k1'));
      const second = await harness.repositories.outbox.enqueue(request('oc:k2'));
      expect(second.sequence).toBeGreaterThan(first.sequence);

      const claimA = await harness.repositories.outbox.claimNext({
        now: EVENT_OUTBOX_BASE_TIME,
        leaseMs: 60_000,
        owner: 'owner-1',
      });
      expect(claimA!.eventSequence).toBe(first.sequence);
      expect(await harness.repositories.outbox.claimNext({
        now: EVENT_OUTBOX_BASE_TIME,
        leaseMs: 60_000,
        owner: 'owner-2',
      })).toBeNull();

      await harness.repositories.outbox.markDelivered(claimA!, {
        deliveredAt: EVENT_OUTBOX_BASE_TIME.toISOString(),
        lastStatus: 200,
      });
      const claimB = await harness.repositories.outbox.claimNext({
        now: EVENT_OUTBOX_BASE_TIME,
        leaseMs: 60_000,
        owner: 'owner-2',
      });
      expect(claimB!.eventSequence).toBe(second.sequence);
    });

    it('does not claim deliveries after a webhook is disabled', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      await harness.repositories.outbox.enqueue(request('oc:k1'));
      await harness.setWebhookEnabled('oc-a', false);

      expect(await harness.repositories.outbox.claimNext({
        now: EVENT_OUTBOX_BASE_TIME,
        leaseMs: 60_000,
        owner: 'owner-1',
      })).toBeNull();
      expect(await harness.repositories.outbox.getNextWakeAt()).toBeNull();
    });

    it('honours retry backoff and reports the next wake moment', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      await harness.repositories.outbox.enqueue(request('oc:k1'));
      await harness.repositories.outbox.enqueue(request('oc:k2'));
      const claim = await harness.repositories.outbox.claimNext({
        now: EVENT_OUTBOX_BASE_TIME,
        leaseMs: 60_000,
        owner: 'owner-1',
      });
      const retryAt = new Date(EVENT_OUTBOX_BASE_TIME.getTime() + 30_000).toISOString();
      expect(await harness.repositories.outbox.scheduleRetry(claim!, {
        nextAttemptAt: retryAt,
        lastError: 'http_server_error',
        lastStatus: 503,
      })).toBe(true);

      expect(await harness.repositories.outbox.claimNext({
        now: new Date(EVENT_OUTBOX_BASE_TIME.getTime() + 29_000),
        leaseMs: 60_000,
        owner: 'owner-1',
      })).toBeNull();
      // The later delivery was created earlier than the retry, but remains
      // blocked by per-webhook ordering and must not force a zero-delay wake.
      expect(new Date(String(await harness.repositories.outbox.getNextWakeAt())).toISOString())
        .toBe(retryAt);

      const retried = await harness.repositories.outbox.claimNext({
        now: new Date(EVENT_OUTBOX_BASE_TIME.getTime() + 30_000),
        leaseMs: 60_000,
        owner: 'owner-1',
      });
      expect(retried!.attemptCount).toBe(2);
    });

    it('recovers stale leases back to pending', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      await harness.repositories.outbox.enqueue(request('oc:k1'));
      const claim = await harness.repositories.outbox.claimNext({
        now: EVENT_OUTBOX_BASE_TIME,
        leaseMs: 1_000,
        owner: 'dead-owner',
      });

      expect(await harness.repositories.outbox.recoverStaleLeases({
        now: new Date(EVENT_OUTBOX_BASE_TIME.getTime() + 500),
      })).toBe(0);
      expect(await harness.repositories.outbox.recoverStaleLeases({
        now: new Date(EVENT_OUTBOX_BASE_TIME.getTime() + 5_000),
      })).toBe(1);
      expect(await harness.getDelivery(claim!.id)).toMatchObject({
        status: 'pending',
        leaseOwner: null,
        leaseToken: null,
      });
    });

    it('dead-letters a delivery whose stored payload cannot be decoded', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      const enqueued = await harness.repositories.outbox.enqueue(request('oc:k1'));
      await harness.poisonPayload(enqueued.sequence);

      expect(await harness.repositories.outbox.claimNext({
        now: EVENT_OUTBOX_BASE_TIME,
        leaseMs: 60_000,
        owner: 'owner-1',
      })).toBeNull();

      const [delivery] = await harness.listDeliveries();
      expect(await harness.getDelivery(delivery.id)).toMatchObject({
        status: 'dead_letter',
        lastError: 'invalid_payload',
      });
    });

    it('records a delivery outcome against the subscription', async () => {
      await harness.seedWebhook({ id: 'oc-a', eventTypes: ['sync.completed'] });
      await harness.repositories.subscriptions.recordDeliveryOutcome({
        webhookId: 'oc-a',
        triggeredAt: EVENT_OUTBOX_BASE_TIME.toISOString(),
        status: 202,
      });

      const matching = await harness.repositories.subscriptions.listMatching('sync.completed');
      expect(matching.map((entry) => entry.id)).toEqual(['oc-a']);
    });
  });
}
