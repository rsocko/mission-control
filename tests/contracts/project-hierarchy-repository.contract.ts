import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ProjectHierarchyPersistence,
} from '@/db/persistence/project-hierarchy';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandRequest,
} from '@/lib/projects/hierarchy-types';

/**
 * One shared behavioural contract for the project-hierarchy command/read
 * boundary, executed against both the SQLite and the PostgreSQL adapter.
 * It covers all seven command types, changed and no-op commands, inverse
 * commands, dense ordering, phase-item identity/metadata preservation,
 * membership/exclusion behaviour, every stable domain error, revision and
 * source fencing, durable idempotency (including canonical JSONB replay and
 * conflicting key reuse), atomic rollback, and the focused reads.
 */

export interface ProjectHierarchyContractFixture {
  projectId: string;
  phaseIds: [string, string];
  taskIds: [string, string, string, string];
  itemIds: [string, string, string];
}

export interface ProjectHierarchyContractSeed {
  /** Removes every row this contract writes, including foreign projects. */
  reset(): Promise<void>;
  /** Seeds the canonical fixture below at hierarchy revision 0. */
  seed(fixture: ProjectHierarchyContractFixture): Promise<void>;
  /** Seeds an empty second project used for cross-project command reuse. */
  seedEmptyProject(projectId: string): Promise<void>;
  readRevision(projectId: string): Promise<number>;
  isMember(projectId: string, taskId: string): Promise<boolean>;
  readExclusion(projectId: string, taskId: string): Promise<string | null>;
  /** Writes `task_projects` outside the adapter to exercise the triggers. */
  addMembershipOutOfBand(projectId: string, taskId: string): Promise<void>;
}

const FIXTURE: ProjectHierarchyContractFixture = {
  projectId: 'contract-project',
  phaseIds: ['contract-phase-a', 'contract-phase-b'],
  taskIds: [
    'contract-task-1',
    'contract-task-2',
    'contract-task-3',
    'contract-task-4',
  ],
  itemIds: ['contract-item-1', 'contract-item-2', 'contract-item-3'],
};
const OTHER_PROJECT = 'contract-other-project';
const [PHASE_A, PHASE_B] = FIXTURE.phaseIds;
const [TASK_1, TASK_2, TASK_3, TASK_4] = FIXTURE.taskIds;
const [ITEM_1, ITEM_2, ITEM_3] = FIXTURE.itemIds;

function commandId(suffix: string) {
  return `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
}

async function expectHierarchyError(
  operation: Promise<unknown>,
  expected: { status: number; code: string },
) {
  await expect(operation).rejects.toMatchObject(expected);
}

export function projectHierarchyRepositoryContract(
  label: string,
  getRepository: () => ProjectHierarchyPersistence,
  getSeed: () => ProjectHierarchyContractSeed,
) {
  describe(`${label} project-hierarchy repository contract`, () => {
    let repository: ProjectHierarchyPersistence;
    let seed: ProjectHierarchyContractSeed;

    beforeEach(async () => {
      repository = getRepository();
      seed = getSeed();
      await seed.reset();
      await seed.seed(FIXTURE);
    });

    async function apply(
      id: string,
      command: ProjectHierarchyCommand,
      options: { projectId?: string; expectedRevision?: number } = {},
    ) {
      const projectId = options.projectId ?? FIXTURE.projectId;
      const expectedRevision = options.expectedRevision
        ?? (await repository.getSnapshot(projectId))?.revision
        ?? 0;
      return repository.applyAuthorizedCommand({
        projectId,
        request: { commandId: commandId(id), expectedRevision, command },
        actor: { type: 'user', id: 'contract' },
      });
    }

    function taskOrder(
      hierarchy: { phaseItemsByPhase: Record<string, Array<{ taskId: string }>> },
      phaseId: string,
    ) {
      return (hierarchy.phaseItemsByPhase[phaseId] ?? []).map((item) => item.taskId);
    }

    it('reads the seeded snapshot in deterministic dense order', async () => {
      const snapshot = await repository.getSnapshot(FIXTURE.projectId);
      expect(snapshot).toMatchObject({ projectId: FIXTURE.projectId, revision: 0 });
      expect(snapshot!.phases.map((phase) => phase.id)).toEqual([PHASE_A, PHASE_B]);
      expect(taskOrder(snapshot!, PHASE_A)).toEqual([TASK_1, TASK_2]);
      expect(taskOrder(snapshot!, PHASE_B)).toEqual([TASK_3]);
      expect(snapshot!.phaseItemsByPhase[PHASE_A][0]).toMatchObject({
        id: ITEM_1,
        estimatedEffortHours: 3,
        isProposed: false,
        proposalType: null,
        sortOrder: 0,
      });
      expect(await repository.getSnapshot('missing-project')).toBeNull();
    });

    it('exposes the focused phase reads', async () => {
      expect(await repository.findPhaseProjectId(PHASE_A)).toBe(FIXTURE.projectId);
      expect(await repository.findPhaseProjectId('missing-phase')).toBeNull();

      const items = await repository.listPhaseItems(PHASE_A);
      expect(items.map((item) => item.id)).toEqual([ITEM_1, ITEM_2]);
      expect(items[0]).toMatchObject({ phaseId: PHASE_A, taskId: TASK_1, sortOrder: 0 });
      expect(await repository.listPhaseItems('missing-phase')).toEqual([]);

      expect(await repository.findPhaseItemTask(PHASE_A, ITEM_1)).toBe(TASK_1);
      expect(await repository.findPhaseItemTask(PHASE_B, ITEM_1)).toBeNull();
      expect(await repository.findPhaseItemTask(PHASE_A, 'missing-item')).toBeNull();
    });

    it('moves a task across phases, densifies order, and preserves item identity', async () => {
      const moved = await apply('1', {
        type: 'move_tasks',
        taskIds: [TASK_1],
        toPhaseId: PHASE_B,
        toIndex: 0,
      });

      expect(moved.revision).toBe(1);
      expect(taskOrder(moved.hierarchy, PHASE_A)).toEqual([TASK_2]);
      expect(taskOrder(moved.hierarchy, PHASE_B)).toEqual([TASK_1, TASK_3]);
      expect(moved.hierarchy.phaseItemsByPhase[PHASE_A][0].sortOrder).toBe(0);
      expect(moved.hierarchy.phaseItemsByPhase[PHASE_B].map((item) => item.sortOrder))
        .toEqual([0, 1]);
      expect(moved.hierarchy.phaseItemsByPhase[PHASE_B][0]).toMatchObject({
        id: ITEM_1,
        estimatedEffortHours: 3,
      });
      expect(moved.inverseCommand).toEqual({
        type: 'restore_task_positions',
        placements: [{
          taskId: TASK_1,
          phaseId: PHASE_A,
          index: 0,
          item: {
            id: ITEM_1,
            estimatedEffortHours: 3,
            isProposed: false,
            proposalType: null,
            createdAt: expect.any(String),
          },
        }],
      });

      const restored = await apply('2', moved.inverseCommand);
      expect(restored.revision).toBe(2);
      expect(taskOrder(restored.hierarchy, PHASE_A)).toEqual([TASK_1, TASK_2]);
      expect(taskOrder(restored.hierarchy, PHASE_B)).toEqual([TASK_3]);
      expect(restored.hierarchy.phaseItemsByPhase[PHASE_A][0].id).toBe(ITEM_1);
    });

    it('records a no-op command as a durable audit at the unchanged revision', async () => {
      const noop = await apply('3', {
        type: 'move_tasks',
        taskIds: [TASK_1],
        toPhaseId: PHASE_A,
        toIndex: 0,
        preserveExistingPosition: true,
      });

      expect(noop.revision).toBe(0);
      expect(await seed.readRevision(FIXTURE.projectId)).toBe(0);
      expect(taskOrder(noop.hierarchy, PHASE_A)).toEqual([TASK_1, TASK_2]);

      const committed = await repository.findCommittedCommand(commandId('3'));
      expect(committed).toMatchObject({ projectId: FIXTURE.projectId });
      expect(committed!.result).toEqual(noop);
    });

    it('reorders phases and rejects an incomplete phase order', async () => {
      const reordered = await apply('4', {
        type: 'reorder_phases',
        orderedPhaseIds: [PHASE_B, PHASE_A],
      });
      expect(reordered.revision).toBe(1);
      expect(reordered.hierarchy.phases.map((phase) => phase.id)).toEqual([PHASE_B, PHASE_A]);
      expect(reordered.inverseCommand).toEqual({
        type: 'reorder_phases',
        orderedPhaseIds: [PHASE_A, PHASE_B],
      });

      const identical = await apply('5', {
        type: 'reorder_phases',
        orderedPhaseIds: [PHASE_B, PHASE_A],
      });
      expect(identical.revision).toBe(1);

      await expectHierarchyError(
        apply('6', { type: 'reorder_phases', orderedPhaseIds: [PHASE_A] }),
        { status: 400, code: 'INVALID_PHASE_ORDER' },
      );
    });

    it('assigns membership and placement atomically and restores both', async () => {
      const assigned = await apply('7', {
        type: 'assign_tasks',
        taskIds: [TASK_4],
        toPhaseId: PHASE_B,
        newItem: { estimatedEffortHours: 8, isProposed: true, proposalType: 'new_task' },
      });

      expect(assigned.revision).toBe(1);
      expect(await seed.isMember(FIXTURE.projectId, TASK_4)).toBe(true);
      expect(taskOrder(assigned.hierarchy, PHASE_B)).toEqual([TASK_3, TASK_4]);
      expect(assigned.hierarchy.phaseItemsByPhase[PHASE_B][1]).toMatchObject({
        taskId: TASK_4,
        estimatedEffortHours: 8,
        isProposed: true,
        proposalType: 'new_task',
        sortOrder: 1,
      });
      expect(assigned.inverseCommand).toEqual({
        type: 'restore_project_tasks',
        states: [{ taskId: TASK_4, member: false, excludedAt: null, placement: null }],
      });

      const restored = await apply('8', assigned.inverseCommand);
      expect(restored.revision).toBe(2);
      expect(await seed.isMember(FIXTURE.projectId, TASK_4)).toBe(false);
      expect(taskOrder(restored.hierarchy, PHASE_B)).toEqual([TASK_3]);
    });

    it('removes a task with an exclusion and restores it with the inverse', async () => {
      const removed = await apply('9', { type: 'remove_tasks', taskIds: [TASK_1] });

      expect(removed.revision).toBe(1);
      expect(await seed.isMember(FIXTURE.projectId, TASK_1)).toBe(false);
      expect(await seed.readExclusion(FIXTURE.projectId, TASK_1)).toEqual(expect.any(String));
      expect(taskOrder(removed.hierarchy, PHASE_A)).toEqual([TASK_2]);
      expect(removed.hierarchy.phaseItemsByPhase[PHASE_A][0].id).toBe(ITEM_2);
      expect(removed.inverseCommand).toMatchObject({
        type: 'restore_project_tasks',
        states: [{ taskId: TASK_1, member: true, excludedAt: null }],
      });

      const restored = await apply('10', removed.inverseCommand);
      expect(restored.revision).toBe(2);
      expect(await seed.isMember(FIXTURE.projectId, TASK_1)).toBe(true);
      expect(await seed.readExclusion(FIXTURE.projectId, TASK_1)).toBeNull();
      expect(taskOrder(restored.hierarchy, PHASE_A)).toEqual([TASK_1, TASK_2]);
      expect(restored.hierarchy.phaseItemsByPhase[PHASE_A][0].id).toBe(ITEM_1);

      const repeated = await apply('11', { type: 'remove_tasks', taskIds: [TASK_4] });
      expect(repeated.revision).toBe(2);
    });

    it('updates phase-item metadata and position with an exact inverse', async () => {
      const updated = await apply('12', {
        type: 'update_phase_item',
        phaseId: PHASE_A,
        taskId: TASK_2,
        toIndex: 0,
        updates: { estimatedEffortHours: 5, isProposed: true },
      });

      expect(updated.revision).toBe(1);
      expect(taskOrder(updated.hierarchy, PHASE_A)).toEqual([TASK_2, TASK_1]);
      expect(updated.hierarchy.phaseItemsByPhase[PHASE_A][0]).toMatchObject({
        id: ITEM_2,
        estimatedEffortHours: 5,
        isProposed: true,
        sortOrder: 0,
      });
      expect(updated.inverseCommand).toEqual({
        type: 'update_phase_item',
        phaseId: PHASE_A,
        taskId: TASK_2,
        toIndex: 1,
        updates: { estimatedEffortHours: null, isProposed: false },
      });

      const reverted = await apply('13', updated.inverseCommand);
      expect(taskOrder(reverted.hierarchy, PHASE_A)).toEqual([TASK_1, TASK_2]);
      expect(reverted.hierarchy.phaseItemsByPhase[PHASE_A][1]).toMatchObject({
        id: ITEM_2,
        estimatedEffortHours: null,
        isProposed: false,
      });
    });

    it('restores explicit task placements', async () => {
      const restored = await apply('14', {
        type: 'restore_task_positions',
        placements: [
          { taskId: TASK_3, phaseId: PHASE_A, index: 0 },
          { taskId: TASK_1, phaseId: null, index: 0 },
        ],
      });

      expect(restored.revision).toBe(1);
      expect(taskOrder(restored.hierarchy, PHASE_A)).toEqual([TASK_3, TASK_2]);
      expect(taskOrder(restored.hierarchy, PHASE_B)).toEqual([]);
      expect(await seed.isMember(FIXTURE.projectId, TASK_1)).toBe(true);
    });

    it('rejects every stable domain error', async () => {
      await expectHierarchyError(
        apply('15', { type: 'remove_tasks', taskIds: [TASK_1] }, { projectId: 'missing-project' }),
        { status: 404, code: 'PROJECT_NOT_FOUND' },
      );
      await expectHierarchyError(
        apply('16', { type: 'remove_tasks', taskIds: ['missing-task'] }),
        { status: 404, code: 'TASK_NOT_FOUND' },
      );
      await expectHierarchyError(
        apply('17', {
          type: 'move_tasks',
          taskIds: [TASK_4],
          toPhaseId: PHASE_A,
          toIndex: 0,
        }),
        { status: 404, code: 'TASK_NOT_IN_PROJECT' },
      );
      await expectHierarchyError(
        apply('18', {
          type: 'move_tasks',
          taskIds: [TASK_1],
          toPhaseId: 'foreign-phase',
          toIndex: 0,
        }),
        { status: 404, code: 'PHASE_NOT_IN_PROJECT' },
      );
      await expectHierarchyError(
        apply('19', {
          type: 'update_phase_item',
          phaseId: 'foreign-phase',
          taskId: TASK_1,
          updates: { isProposed: true },
        }),
        { status: 404, code: 'PHASE_NOT_IN_PROJECT' },
      );
      await expectHierarchyError(
        apply('20', {
          type: 'update_phase_item',
          phaseId: PHASE_B,
          taskId: TASK_1,
          updates: { isProposed: true },
        }),
        { status: 404, code: 'PHASE_ITEM_NOT_FOUND' },
      );
      await expectHierarchyError(
        apply('21', {
          type: 'move_tasks',
          taskIds: [TASK_1],
          toPhaseId: null,
          toIndex: 0,
          fromPhaseId: PHASE_B,
        }),
        { status: 409, code: 'HIERARCHY_SOURCE_CONFLICT' },
      );

      expect(await seed.readRevision(FIXTURE.projectId)).toBe(0);
    });

    it('fences a stale revision and returns the current hierarchy', async () => {
      await apply('22', { type: 'move_tasks', taskIds: [TASK_1], toPhaseId: PHASE_B, toIndex: 0 });

      await expect(repository.applyAuthorizedCommand({
        projectId: FIXTURE.projectId,
        request: {
          commandId: commandId('23'),
          expectedRevision: 0,
          command: { type: 'move_tasks', taskIds: [TASK_2], toPhaseId: PHASE_B, toIndex: 0 },
        },
      })).rejects.toMatchObject({
        status: 409,
        code: 'HIERARCHY_REVISION_CONFLICT',
        current: expect.objectContaining({ revision: 1 }),
      });
    });

    it('rolls the whole command back when any task is outside the project', async () => {
      await expectHierarchyError(
        apply('24', {
          type: 'move_tasks',
          taskIds: [TASK_1, TASK_4],
          toPhaseId: PHASE_B,
          toIndex: 0,
        }),
        { status: 404, code: 'TASK_NOT_IN_PROJECT' },
      );

      const snapshot = await repository.getSnapshot(FIXTURE.projectId);
      expect(snapshot!.revision).toBe(0);
      expect(taskOrder(snapshot!, PHASE_A)).toEqual([TASK_1, TASK_2]);
      expect(taskOrder(snapshot!, PHASE_B)).toEqual([TASK_3]);
      expect(await repository.findCommittedCommand(commandId('24'))).toBeNull();
    });

    it('replays an identical command exactly, including canonical JSON ordering', async () => {
      const command: ProjectHierarchyCommand = {
        type: 'move_tasks',
        taskIds: [TASK_1],
        toPhaseId: PHASE_B,
        toIndex: 0,
      };
      const first = await apply('25', command);
      expect(first.revision).toBe(1);

      const replay = await repository.applyAuthorizedCommand({
        projectId: FIXTURE.projectId,
        request: { commandId: commandId('25'), expectedRevision: 0, command },
      });
      expect(replay).toEqual(first);
      expect(await seed.readRevision(FIXTURE.projectId)).toBe(1);

      // Same values, different key order plus an explicitly-undefined member:
      // `jsonb` normalizes both, so replay must compare structurally.
      const reordered = {
        command: {
          toIndex: 0,
          toPhaseId: PHASE_B,
          taskIds: [TASK_1],
          type: 'move_tasks',
          newItem: undefined,
        },
        expectedRevision: 0,
        commandId: commandId('25'),
      } as unknown as ProjectHierarchyCommandRequest;
      expect(await repository.applyAuthorizedCommand({
        projectId: FIXTURE.projectId,
        request: reordered,
      })).toEqual(first);
      expect(await seed.readRevision(FIXTURE.projectId)).toBe(1);
    });

    it('rejects command-ID reuse for another request or another project', async () => {
      await apply('26', { type: 'move_tasks', taskIds: [TASK_1], toPhaseId: PHASE_B, toIndex: 0 });

      await expectHierarchyError(repository.applyAuthorizedCommand({
        projectId: FIXTURE.projectId,
        request: {
          commandId: commandId('26'),
          expectedRevision: 0,
          command: { type: 'move_tasks', taskIds: [TASK_2], toPhaseId: PHASE_B, toIndex: 0 },
        },
      }), { status: 409, code: 'COMMAND_ID_CONFLICT' });

      await seed.seedEmptyProject(OTHER_PROJECT);
      await expectHierarchyError(repository.applyAuthorizedCommand({
        projectId: OTHER_PROJECT,
        request: {
          commandId: commandId('26'),
          expectedRevision: 0,
          command: { type: 'move_tasks', taskIds: [TASK_1], toPhaseId: PHASE_B, toIndex: 0 },
        },
      }), { status: 409, code: 'COMMAND_ID_CONFLICT' });

      expect(await seed.readRevision(FIXTURE.projectId)).toBe(1);
    });

    it('advances the revision once per command and once per out-of-band write', async () => {
      await seed.addMembershipOutOfBand(FIXTURE.projectId, TASK_4);
      expect(await seed.readRevision(FIXTURE.projectId)).toBe(1);

      const moved = await apply('27', {
        type: 'move_tasks',
        taskIds: [TASK_1, TASK_2],
        toPhaseId: PHASE_B,
        toIndex: 0,
      });
      expect(moved.revision).toBe(2);
      expect(await seed.readRevision(FIXTURE.projectId)).toBe(2);
      expect(taskOrder(moved.hierarchy, PHASE_B)).toEqual([TASK_1, TASK_2, TASK_3]);
    });
  });
}
