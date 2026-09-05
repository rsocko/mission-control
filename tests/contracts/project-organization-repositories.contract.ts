import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectAutomationRepository } from '@/db/persistence/project-automation';
import type {
  ListOrganizationGroup,
  ProjectOrganizationProject,
} from '@/db/persistence/project-organization';

export const ORGANIZATION_FIXTURE = {
  projectId: 'organization-contract-project',
  hiddenProjectId: 'organization-contract-hidden',
  otherProjectId: 'organization-contract-other',
  phaseA: 'organization-contract-phase-a',
  phaseB: 'organization-contract-phase-b',
  taskA: 'organization-contract-task-a',
  taskB: 'organization-contract-task-b',
  itemA: 'organization-contract-item-a',
  itemB: 'organization-contract-item-b',
  groupA: 'organization-contract-group-a',
  groupB: 'organization-contract-group-b',
  groupC: 'organization-contract-group-c',
  listA: 'organization-contract-list-a',
  listB: 'organization-contract-list-b',
} as const;

export const ORGANIZATION_NOW = '2026-01-01T00:00:00.000Z';

export interface ProjectOrganizationContractSeed {
  reset(): Promise<void>;
  seed(): Promise<void>;
}

function project(
  id: string,
  name: string,
  overrides: Partial<ProjectOrganizationProject> = {},
): ProjectOrganizationProject {
  return {
    id,
    name,
    description: null,
    color: '#3b82f6',
    icon: null,
    iconColor: '#3b82f6',
    sourceBindings: [],
    autoIncludeRules: [],
    kanbanColumns: [],
    defaultView: 'list',
    defaultFilters: null,
    status: 'active',
    statusOverride: null,
    hidden: false,
    category: null,
    targetDate: null,
    startedAt: null,
    completedAt: null,
    sortOrder: 0,
    hierarchyRevision: 0,
    metadata: {},
    createdAt: ORGANIZATION_NOW,
    updatedAt: ORGANIZATION_NOW,
    ...overrides,
  };
}

function group(id: string, name: string): ListOrganizationGroup {
  return {
    id,
    name,
    icon: null,
    iconColor: null,
    sourceId: null,
    sortOrder: 0,
    createdAt: ORGANIZATION_NOW,
  };
}

function commandId(suffix: string) {
  return `30000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
}

export function projectOrganizationRepositoriesContract(
  label: string,
  getRepository: () => ProjectAutomationRepository,
  getSeed: () => ProjectOrganizationContractSeed,
) {
  describe(`${label} project-organization repository contract`, () => {
    let repository: ProjectAutomationRepository;
    let seed: ProjectOrganizationContractSeed;

    beforeEach(async () => {
      repository = getRepository();
      seed = getSeed();
      await seed.reset();
      await seed.seed();
    });

    it('reads projects and phases in deterministic order without leaking hidden projects', async () => {
      const visible = await repository.projectAdministration.listProjects({
        includeHidden: false,
        includePhases: true,
      });
      expect(visible.map(({ id }) => id)).toEqual([
        ORGANIZATION_FIXTURE.otherProjectId,
        ORGANIZATION_FIXTURE.projectId,
      ]);
      expect(visible[1]).toMatchObject({
        id: ORGANIZATION_FIXTURE.projectId,
        sourceBindings: [],
        autoIncludeRules: [
          { type: 'title_contains', value: 'match' },
          { type: 'connector', value: 'organization-connector' },
        ],
        phases: [
          { id: ORGANIZATION_FIXTURE.phaseB, name: 'Build' },
          { id: ORGANIZATION_FIXTURE.phaseA, name: 'Design' },
        ],
      });

      const all = await repository.projectAdministration.listProjects({
        includeHidden: true,
        includePhases: false,
      });
      expect(all.map(({ id }) => id)).toContain(ORGANIZATION_FIXTURE.hiddenProjectId);
    });

    it('updates projects atomically and returns affected tasks in stable order', async () => {
      const result = await repository.projectAdministration.updateProject(
        ORGANIZATION_FIXTURE.projectId,
        {
          name: 'Renamed',
          metadata: { owner: 'platform' },
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      );
      expect(result.affectedTaskIds).toEqual([
        ORGANIZATION_FIXTURE.taskA,
        ORGANIZATION_FIXTURE.taskB,
      ]);
      await expect(repository.projectAdministration.getProject(
        ORGANIZATION_FIXTURE.projectId,
      )).resolves.toMatchObject({
        name: 'Renamed',
        metadata: { owner: 'platform' },
        hierarchyRevision: 0,
      });
    });

    it('preserves the two project deletion policies', async () => {
      await repository.projectAdministration.deleteProject(
        ORGANIZATION_FIXTURE.projectId,
        'memberships',
      );
      await expect(repository.projectAdministration.getProject(
        ORGANIZATION_FIXTURE.projectId,
      )).resolves.toBeNull();
      await expect(repository.projectAdministration.getPhase(
        ORGANIZATION_FIXTURE.phaseA,
      )).resolves.not.toBeNull();

      await seed.reset();
      await seed.seed();
      await repository.projectAdministration.deleteProject(
        ORGANIZATION_FIXTURE.projectId,
        'owned-hierarchy',
      );
      await expect(repository.projectAdministration.getPhase(
        ORGANIZATION_FIXTURE.phaseA,
      )).resolves.toBeNull();
      await expect(repository.projectAdministration.getPhase(
        ORGANIZATION_FIXTURE.phaseB,
      )).resolves.toBeNull();
    });

    it('orders phase items and atomically clears dependencies during deletion', async () => {
      const phase = await repository.projectAdministration.getPhase(
        ORGANIZATION_FIXTURE.phaseA,
      );
      expect(phase?.items.map(({ id }) => id)).toEqual([
        ORGANIZATION_FIXTURE.itemB,
        ORGANIZATION_FIXTURE.itemA,
      ]);

      await repository.projectAdministration.deletePhase(
        ORGANIZATION_FIXTURE.phaseA,
      );
      await expect(repository.projectAdministration.getPhase(
        ORGANIZATION_FIXTURE.phaseA,
      )).resolves.toBeNull();
      await expect(repository.projectAdministration.getPhase(
        ORGANIZATION_FIXTURE.phaseB,
      )).resolves.toMatchObject({
        phase: { startAfterPhaseId: null },
      });
    });

    it('keeps phase administration in the hierarchy revision/CAS domain', async () => {
      await repository.projectAdministration.createPhase({
        id: 'organization-contract-phase-c',
        projectId: ORGANIZATION_FIXTURE.projectId,
        name: 'Ship',
        description: null,
        status: 'pending',
        color: null,
        estimatedDays: null,
        targetStart: null,
        targetEnd: null,
        startAfterPhaseId: ORGANIZATION_FIXTURE.phaseB,
        sortOrder: 2,
        completedAt: null,
        createdAt: ORGANIZATION_NOW,
        updatedAt: ORGANIZATION_NOW,
      });

      await expect(repository.hierarchy.applyAuthorizedCommand({
        projectId: ORGANIZATION_FIXTURE.projectId,
        request: {
          commandId: commandId('1'),
          expectedRevision: 0,
          command: {
            type: 'reorder_phases',
            orderedPhaseIds: [
              ORGANIZATION_FIXTURE.phaseB,
              ORGANIZATION_FIXTURE.phaseA,
              'organization-contract-phase-c',
            ],
          },
        },
      })).rejects.toMatchObject({
        status: 409,
        code: 'HIERARCHY_REVISION_CONFLICT',
      });
    });

    it('allows exactly one concurrent hierarchy command from one revision', async () => {
      const results = await Promise.allSettled([
        repository.hierarchy.applyAuthorizedCommand({
          projectId: ORGANIZATION_FIXTURE.projectId,
          request: {
            commandId: commandId('2'),
            expectedRevision: 0,
            command: {
              type: 'reorder_phases',
              orderedPhaseIds: [
                ORGANIZATION_FIXTURE.phaseA,
                ORGANIZATION_FIXTURE.phaseB,
              ],
            },
          },
        }),
        repository.hierarchy.applyAuthorizedCommand({
          projectId: ORGANIZATION_FIXTURE.projectId,
          request: {
            commandId: commandId('3'),
            expectedRevision: 0,
            command: {
              type: 'reorder_phases',
              orderedPhaseIds: [
                ORGANIZATION_FIXTURE.phaseB,
                ORGANIZATION_FIXTURE.phaseA,
              ],
            },
          },
        }),
      ]);
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    });

    it('returns rule matches and reasons in deterministic order', async () => {
      const matches = await repository.previewProject(ORGANIZATION_FIXTURE.projectId);
      expect(matches.map(({ taskId }) => taskId)).toEqual([
        ORGANIZATION_FIXTURE.taskA,
        ORGANIZATION_FIXTURE.taskB,
      ]);
      expect(matches[0].reasons).toEqual([
        'Title contains "match"',
        'Connector "organization-connector"',
      ]);
    });

    it('groups lists with deterministic identity, display names, and live counts', async () => {
      const snapshot = await repository.listOrganization.getSnapshot();
      expect(snapshot.groups.map(({ id }) => id)).toEqual([
        ORGANIZATION_FIXTURE.groupB,
        ORGANIZATION_FIXTURE.groupA,
      ]);
      expect(snapshot.groups[1].sourceLists.map(({ id }) => id)).toEqual([
        ORGANIZATION_FIXTURE.listB,
        ORGANIZATION_FIXTURE.listA,
      ]);
      expect(snapshot.groups[1].sourceLists).toEqual([
        expect.objectContaining({
          id: ORGANIZATION_FIXTURE.listB,
          name: 'A display',
          taskCount: 1,
        }),
        expect.objectContaining({
          id: ORGANIZATION_FIXTURE.listA,
          name: 'Zulu',
          taskCount: 1,
        }),
      ]);
    });

    it('serializes concurrent group creation and rejects duplicate identity', async () => {
      await Promise.all([
        repository.listOrganization.createGroup(group(
          ORGANIZATION_FIXTURE.groupC,
          'Charlie',
        )),
        repository.listOrganization.createGroup(group(
          'organization-contract-group-d',
          'Delta',
        )),
      ]);
      const snapshot = await repository.listOrganization.getSnapshot();
      expect(snapshot.groups.map(({ sortOrder }) => sortOrder)).toEqual([0, 1, 2, 3]);

      await expect(repository.listOrganization.createGroup(group(
        ORGANIZATION_FIXTURE.groupA,
        'Duplicate',
      ))).rejects.toBeTruthy();
      await expect(repository.listOrganization.getSnapshot()).resolves.toMatchObject({
        groups: expect.arrayContaining([
          expect.objectContaining({
            id: ORGANIZATION_FIXTURE.groupA,
            name: 'Zulu group',
          }),
        ]),
      });
    });

    it('makes reorder atomic and deletion reassigns grouped lists', async () => {
      await repository.listOrganization.createGroup(group(
        ORGANIZATION_FIXTURE.groupC,
        'Charlie',
      ));
      const orders = [
        [
          ORGANIZATION_FIXTURE.groupC,
          ORGANIZATION_FIXTURE.groupB,
          ORGANIZATION_FIXTURE.groupA,
        ],
        [
          ORGANIZATION_FIXTURE.groupB,
          ORGANIZATION_FIXTURE.groupA,
          ORGANIZATION_FIXTURE.groupC,
        ],
      ];
      await Promise.all(orders.map((orderedIds) => (
        repository.listOrganization.reorderGroups(orderedIds)
      )));
      const reordered = await repository.listOrganization.getSnapshot();
      expect(orders).toContainEqual(reordered.groups.map(({ id }) => id));
      expect(reordered.groups.map(({ sortOrder }) => sortOrder)).toEqual([0, 1, 2]);

      await repository.listOrganization.updateGroup(
        ORGANIZATION_FIXTURE.groupA,
        { name: 'Renamed group', icon: 'folder' },
      );
      await repository.listOrganization.deleteGroup(ORGANIZATION_FIXTURE.groupA);
      const deleted = await repository.listOrganization.getSnapshot();
      expect(deleted.groups.map(({ id }) => id)).not.toContain(
        ORGANIZATION_FIXTURE.groupA,
      );
      expect(deleted.ungroupedLists.map(({ id }) => id)).toEqual([
        ORGANIZATION_FIXTURE.listB,
        ORGANIZATION_FIXTURE.listA,
      ]);
    });

    it('rejects duplicate project identity without replacing the original row', async () => {
      await expect(repository.projectAdministration.createProject(project(
        ORGANIZATION_FIXTURE.projectId,
        'Duplicate project',
      ))).rejects.toBeTruthy();
      await expect(repository.projectAdministration.getProject(
        ORGANIZATION_FIXTURE.projectId,
      )).resolves.toMatchObject({ name: 'Zulu project' });
    });
  });
}
