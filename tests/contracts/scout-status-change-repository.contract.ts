import { describe, expect, it } from 'vitest';
import type {
  ScoutStatusChangeRecord,
  ScoutStatusChangeRepository,
} from '@/lib/connectors/scout/status-change-repository';

export const SCOUT_STATUS_NOW = '2026-09-08T12:00:00.000Z';

export interface ScoutStatusChangeContractHarness {
  repository: ScoutStatusChangeRepository;
  reset(): Promise<void>;
  seed(records: readonly ScoutStatusChangeRecord[]): Promise<void>;
}

const records: ScoutStatusChangeRecord[] = [
  {
    mcTaskId: 'scout-status-a',
    sourceId: 'scout:email:a',
    sourceType: 'email',
    title: 'Email A',
    status: 'todo',
    statusReason: null,
    updatedAt: '2026-09-08T10:00:00.000Z',
    completedAt: null,
    snoozedUntil: null,
  },
  {
    mcTaskId: 'scout-status-b',
    sourceId: 'scout:teams:b',
    sourceType: 'teams',
    title: 'Teams B',
    status: 'done',
    statusReason: 'handled',
    updatedAt: '2026-09-08T10:00:00.000Z',
    completedAt: '2026-09-08T10:00:00.000Z',
    snoozedUntil: null,
  },
  {
    mcTaskId: 'scout-status-c',
    sourceId: 'scout:email:c',
    sourceType: 'email',
    title: 'Email C',
    status: 'in_progress',
    statusReason: null,
    updatedAt: '2026-09-08T11:00:00.000Z',
    completedAt: null,
    snoozedUntil: null,
  },
  {
    mcTaskId: 'scout-status-future',
    sourceId: 'scout:email:future',
    sourceType: 'email',
    title: 'Future',
    status: 'todo',
    statusReason: null,
    updatedAt: '2026-09-08T13:00:00.000Z',
    completedAt: null,
    snoozedUntil: null,
  },
];

export function describeScoutStatusChangeRepositoryContract(
  backend: string,
  getHarness: () => ScoutStatusChangeContractHarness,
): void {
  describe(`${backend} Scout status-change repository contract`, () => {
    it('orders deterministically, fences the snapshot, and reports remaining rows', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seed(records);

      const page = await harness.repository.listChanges({
        since: null,
        through: SCOUT_STATUS_NOW,
        sourceTypes: null,
        limit: 2,
      });

      expect(page.changes.map(({ mcTaskId }) => mcTaskId)).toEqual([
        'scout-status-a',
        'scout-status-b',
      ]);
      expect(page.hasMore).toBe(true);
    });

    it('filters source types before limiting and applies an exclusive cursor', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seed(records);

      const page = await harness.repository.listChanges({
        since: '2026-09-08T10:00:00.000Z',
        through: SCOUT_STATUS_NOW,
        sourceTypes: ['email'],
        limit: 1,
      });

      expect(page).toEqual({
        changes: [records[2]],
        hasMore: false,
      });
    });

    it('advances acknowledgements monotonically and makes replays no-ops', async () => {
      const harness = getHarness();
      await harness.reset();
      const first = '2026-09-08T10:00:00.000Z';
      const second = '2026-09-08T11:00:00.000Z';

      expect((await harness.repository.acknowledge({
        acknowledgedAt: first,
        updatedAt: SCOUT_STATUS_NOW,
      }))).toMatchObject({ cursor: first, advanced: true });
      expect((await harness.repository.acknowledge({
        acknowledgedAt: first,
        updatedAt: SCOUT_STATUS_NOW,
      }))).toMatchObject({ cursor: first, advanced: false });
      expect((await harness.repository.acknowledge({
        acknowledgedAt: '2026-09-08T09:00:00.000Z',
        updatedAt: SCOUT_STATUS_NOW,
      }))).toMatchObject({ cursor: first, advanced: false });
      expect((await harness.repository.acknowledge({
        acknowledgedAt: second,
        updatedAt: SCOUT_STATUS_NOW,
      }))).toMatchObject({ cursor: second, advanced: true });
      await expect(harness.repository.getAcknowledgedCursor()).resolves.toBe(second);
    });

    it('compares legacy offset cursors by instant rather than text', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.repository.acknowledge({
        acknowledgedAt: '2026-09-08T12:00:00+02:00',
        updatedAt: SCOUT_STATUS_NOW,
      });

      expect((await harness.repository.acknowledge({
        acknowledgedAt: '2026-09-08T10:30:00.000Z',
        updatedAt: SCOUT_STATUS_NOW,
      }))).toMatchObject({
        cursor: '2026-09-08T10:30:00.000Z',
        advanced: true,
      });
    });

    it('preserves the maximum cursor under concurrent retries', async () => {
      const harness = getHarness();
      await harness.reset();
      const cursors = Array.from({ length: 8 }, (_, index) => (
        `2026-09-08T${String(index + 1).padStart(2, '0')}:00:00.000Z`
      ));

      await Promise.all(cursors.map((acknowledgedAt) => harness.repository.acknowledge({
        acknowledgedAt,
        updatedAt: SCOUT_STATUS_NOW,
      })));

      await expect(harness.repository.getAcknowledgedCursor()).resolves.toBe(cursors.at(-1));
    });
  });
}
