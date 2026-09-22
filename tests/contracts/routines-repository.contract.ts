import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CreateRoutineCommand,
  RoutineCadenceType,
  RoutinesRepository,
} from '@/db/persistence/routines';

export const ROUTINES_NOW = '2026-09-01T12:00:00.000Z';

export interface RoutinesContractHarness {
  repository: RoutinesRepository;
  reset(): Promise<void>;
}

function routine(
  id: string,
  cadenceType: RoutineCadenceType = 'daily',
  createdAt = ROUTINES_NOW,
): CreateRoutineCommand {
  return {
    id,
    name: `Routine ${id}`,
    description: null,
    cadenceType,
    cadenceConfig: cadenceType === 'specific_days' ? { days: [1, 3, 5] } : {},
    icon: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function describeRoutinesRepositoryContract(
  label: string,
  createHarness: () => RoutinesContractHarness | Promise<RoutinesContractHarness>,
): void {
  describe(`${label} routines repository contract`, () => {
    let harness: RoutinesContractHarness;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
    });

    it('allocates sort order and reads routines in the legacy stable order', async () => {
      await harness.repository.createRoutine(routine('routine-first', 'daily', ROUTINES_NOW));
      await harness.repository.createRoutine(routine(
        'routine-second',
        'specific_days',
        '2026-09-01T12:00:01.000Z',
      ));

      const records = await harness.repository.listRoutines(false);
      expect(records.map(({ id, sortOrder }) => ({ id, sortOrder }))).toEqual([
        { id: 'routine-first', sortOrder: 0 },
        { id: 'routine-second', sortOrder: 1 },
      ]);
      expect(records[1]).toMatchObject({
        cadenceType: 'specific_days',
        cadenceConfig: { days: [1, 3, 5] },
        isActive: true,
        isArchived: false,
      });
    });

    it('updates allowed fields and preserves archive-as-delete semantics', async () => {
      await harness.repository.createRoutine(routine('routine-update'));
      await expect(harness.repository.updateRoutine('routine-missing', {
        updates: { name: 'Missing' },
        updatedAt: '2026-09-02T00:00:00.000Z',
      })).resolves.toBe(false);

      await expect(harness.repository.updateRoutine('routine-update', {
        updates: {
          name: 'Updated',
          cadenceConfig: { target: 3 },
          sortOrder: 7,
        },
        updatedAt: '2026-09-02T00:00:00.000Z',
      })).resolves.toBe(true);
      await expect(harness.repository.getRoutine('routine-update')).resolves.toMatchObject({
        name: 'Updated',
        cadenceConfig: { target: 3 },
        sortOrder: 7,
        updatedAt: '2026-09-02T00:00:00.000Z',
      });

      await expect(harness.repository.archiveRoutine(
        'routine-update',
        '2026-09-03T00:00:00.000Z',
      )).resolves.toBe(true);
      await expect(harness.repository.listRoutines(false)).resolves.toEqual([]);
      await expect(harness.repository.listRoutines(true)).resolves.toEqual([
        expect.objectContaining({
          id: 'routine-update',
          isActive: false,
          isArchived: true,
          updatedAt: '2026-09-03T00:00:00.000Z',
        }),
      ]);
    });

    it('serializes daily and specific-day completion idempotency', async () => {
      await harness.repository.createRoutine(routine('routine-daily'));
      await harness.repository.createRoutine(routine('routine-specific', 'specific_days'));

      await expect(harness.repository.createCompletion({
        id: 'completion-daily-a',
        routineId: 'routine-daily',
        date: '2026-09-02',
        notes: null,
        completedAt: ROUTINES_NOW,
      })).resolves.toEqual({ outcome: 'created' });
      await expect(harness.repository.createCompletion({
        id: 'completion-daily-b',
        routineId: 'routine-daily',
        date: '2026-09-02',
        notes: 'duplicate',
        completedAt: ROUTINES_NOW,
      })).resolves.toEqual({ outcome: 'duplicate' });
      await expect(harness.repository.createCompletion({
        id: 'completion-specific-a',
        routineId: 'routine-specific',
        date: '2026-09-03',
        notes: null,
        completedAt: ROUTINES_NOW,
      })).resolves.toEqual({ outcome: 'created' });
      await expect(harness.repository.createCompletion({
        id: 'completion-specific-b',
        routineId: 'routine-specific',
        date: '2026-09-03',
        notes: null,
        completedAt: ROUTINES_NOW,
      })).resolves.toEqual({ outcome: 'duplicate' });
      await expect(harness.repository.createCompletion({
        id: 'completion-missing',
        routineId: 'routine-missing',
        date: '2026-09-03',
        notes: null,
        completedAt: ROUTINES_NOW,
      })).resolves.toEqual({ outcome: 'routine-not-found' });
    });

    it('allows over-completion cadences and preserves completion range ordering', async () => {
      await harness.repository.createRoutine(routine('routine-flex', 'x_per_week'));
      for (const [id, date] of [
        ['completion-c', '2026-09-03'],
        ['completion-a', '2026-09-01'],
        ['completion-b', '2026-09-02'],
        ['completion-bonus', '2026-09-02'],
      ]) {
        await expect(harness.repository.createCompletion({
          id,
          routineId: 'routine-flex',
          date,
          notes: id === 'completion-bonus' ? 'bonus' : null,
          completedAt: `${date}T12:00:00.000Z`,
        })).resolves.toEqual({ outcome: 'created' });
      }

      const ascending = await harness.repository.listCompletions({
        fromInclusive: '2026-09-01',
        toInclusive: '2026-09-03',
        routineId: 'routine-flex',
        order: 'ascending',
      });
      expect(ascending.map(({ date }) => date)).toEqual([
        '2026-09-01',
        '2026-09-02',
        '2026-09-02',
        '2026-09-03',
      ]);
      expect((await harness.repository.listCompletions({
        fromInclusive: '2026-09-02',
        order: 'descending',
      })).map(({ date }) => date)).toEqual([
        '2026-09-03',
        '2026-09-02',
        '2026-09-02',
      ]);

      await harness.repository.deleteCompletionById('completion-bonus');
      await harness.repository.deleteCompletionsForDate('routine-flex', '2026-09-03');
      await expect(harness.repository.listCompletions({
        fromInclusive: '2026-09-01',
        toInclusive: '2026-09-03',
        routineId: 'routine-flex',
        order: 'ascending',
      })).resolves.toEqual([
        expect.objectContaining({ id: 'completion-a' }),
        expect.objectContaining({ id: 'completion-b' }),
      ]);
    });
  });
}
