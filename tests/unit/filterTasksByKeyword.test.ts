import { filterTasksByKeyword } from '@/lib/utils/filterTasksByKeyword';
import type { DashboardTaskViewModel as Task } from '@/types/dashboard';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Default task title',
    status: 'todo',
    localDisposition: 'active',
    taskSourceModel: 'remote-managed',
    microStatus: null,
    priority: 'medium',
    dueDate: null,
    connectorType: 'github-issues',
    connectorInstanceId: 'inst-1',
    sourceListName: null,
    assignee: null,
    tags: [],
    metadata: null,
    sourceId: null,
    hasDescription: false,
    editPolicy: editableTaskPolicy,
    ...overrides,
  };
}

describe('filterTasksByKeyword', () => {
  const tasks: Task[] = [
    makeTask({ id: '1', title: 'Home Assistant connector device alerts', tags: [{ id: 't1', name: 'type:feature', slug: 'type-feature', type: 'label', color: null }] }),
    makeTask({ id: '2', title: 'Fix login page bug', tags: [{ id: 't2', name: 'type:bug', slug: 'type-bug', type: 'label', color: null }] }),
    makeTask({ id: '3', title: 'Add Todoist sync', sourceListName: 'Backlog', assignee: 'octo-org' }),
    makeTask({ id: '4', title: 'Design new dashboard', tags: [{ id: 't3', name: 'area:ui', slug: 'area-ui', type: 'label', color: null }] }),
    makeTask({ id: '5', title: 'Refactor connector architecture', metadata: '{"notes":"Important refactoring for connectors"}' }),
  ];

  it('returns all tasks when keyword is empty', () => {
    expect(filterTasksByKeyword(tasks, '')).toHaveLength(5);
    expect(filterTasksByKeyword(tasks, '   ')).toHaveLength(5);
  });

  it('filters by title match (case-insensitive)', () => {
    const result = filterTasksByKeyword(tasks, 'connector');
    expect(result.map(t => t.id)).toEqual(['1', '5']);
  });

  it('filters by tag name match', () => {
    const result = filterTasksByKeyword(tasks, 'type:bug');
    expect(result.map(t => t.id)).toEqual(['2']);
  });

  it('filters by tag slug match', () => {
    const result = filterTasksByKeyword(tasks, 'area-ui');
    expect(result.map(t => t.id)).toEqual(['4']);
  });

  it('filters by sourceListName', () => {
    const result = filterTasksByKeyword(tasks, 'backlog');
    expect(result.map(t => t.id)).toEqual(['3']);
  });

  it('filters by assignee', () => {
    const result = filterTasksByKeyword(tasks, 'octo-org');
    expect(result.map(t => t.id)).toEqual(['3']);
  });

  it('filters by metadata content', () => {
    const result = filterTasksByKeyword(tasks, 'refactoring');
    expect(result.map(t => t.id)).toEqual(['5']);
  });

  it('supports multiple search terms (AND logic)', () => {
    const result = filterTasksByKeyword(tasks, 'connector device');
    expect(result.map(t => t.id)).toEqual(['1']);
  });

  it('is case-insensitive', () => {
    const result = filterTasksByKeyword(tasks, 'HOME ASSISTANT');
    expect(result.map(t => t.id)).toEqual(['1']);
  });

  it('returns empty array when nothing matches', () => {
    const result = filterTasksByKeyword(tasks, 'zzz_no_match');
    expect(result).toHaveLength(0);
  });

  // ── Structured token tests ────────────────────────────────────────────────

  describe('structured token: title:', () => {
    it('filters by title: token (substring)', () => {
      const result = filterTasksByKeyword(tasks, 'title:connector');
      expect(result.map(t => t.id)).toEqual(['1', '5']);
    });

    it('title: is case-insensitive', () => {
      const result = filterTasksByKeyword(tasks, 'title:CONNECTOR');
      expect(result.map(t => t.id)).toEqual(['1', '5']);
    });

    it('title: returns empty when no match', () => {
      const result = filterTasksByKeyword(tasks, 'title:zzz_nomatch');
      expect(result).toHaveLength(0);
    });
  });

  describe('structured token: tag:', () => {
    it('filters by tag: slug (exact)', () => {
      const result = filterTasksByKeyword(tasks, 'tag:area-ui');
      expect(result.map(t => t.id)).toEqual(['4']);
    });

    it('filters by tag: name (exact)', () => {
      const result = filterTasksByKeyword(tasks, 'tag:type:bug');
      expect(result.map(t => t.id)).toEqual(['2']);
    });

    it('tag: returns empty when no match', () => {
      const result = filterTasksByKeyword(tasks, 'tag:nonexistent-tag');
      expect(result).toHaveLength(0);
    });
  });

  describe('structured token: priority:', () => {
    const priorityTasks: Task[] = [
      makeTask({ id: 'p0', title: 'Critical priority task', priority: 'critical' }),
      makeTask({ id: 'p1', title: 'High priority task', priority: 'high' }),
      makeTask({ id: 'p2', title: 'Low priority task', priority: 'low' }),
      makeTask({ id: 'p3', title: 'Medium priority task', priority: 'medium' }),
      makeTask({ id: 'p4', title: 'No priority task', priority: 'none' }),
    ];

    it('filters by priority: token', () => {
      const result = filterTasksByKeyword(priorityTasks, 'priority:high');
      expect(result.map(t => t.id)).toEqual(['p1']);
    });

    it('priority: is case-insensitive', () => {
      const result = filterTasksByKeyword(priorityTasks, 'priority:HIGH');
      expect(result.map(t => t.id)).toEqual(['p1']);
    });

    it('matches priority thresholds and no priority consistently with the API', () => {
      expect(filterTasksByKeyword(priorityTasks, 'priority:>=high').map((task) => task.id))
        .toEqual(['p0', 'p1']);
      expect(filterTasksByKeyword(priorityTasks, 'priority:<=medium').map((task) => task.id))
        .toEqual(['p2', 'p3', 'p4']);
      expect(filterTasksByKeyword(priorityTasks, 'priority:none').map((task) => task.id))
        .toEqual(['p4']);
      expect(filterTasksByKeyword(priorityTasks, '-priority:none').map((task) => task.id))
        .toEqual(['p0', 'p1', 'p2', 'p3']);
    });
  });

  describe('structured token: status:', () => {
    const statusTasks: Task[] = [
      makeTask({ id: 's1', title: 'Todo task', status: 'todo' }),
      makeTask({ id: 's2', title: 'In progress task', status: 'in_progress' }),
      makeTask({ id: 's3', title: 'Done task', status: 'done' }),
    ];

    it('filters by status: token', () => {
      const result = filterTasksByKeyword(statusTasks, 'status:todo');
      expect(result.map(t => t.id)).toEqual(['s1']);
    });
  });

  describe('structured token: source:', () => {
    const sourceTasks: Task[] = [
      makeTask({ id: 'src1', title: 'GitHub task', connectorType: 'github-issues' }),
      makeTask({ id: 'src2', title: 'Todoist task', connectorType: 'todoist' }),
    ];

    it('filters by source: token', () => {
      const result = filterTasksByKeyword(sourceTasks, 'source:github-issues');
      expect(result.map(t => t.id)).toEqual(['src1']);
    });
  });

  describe('structured token: list:', () => {
    it('filters by list: token (substring)', () => {
      const result = filterTasksByKeyword(tasks, 'list:back');
      expect(result.map(t => t.id)).toEqual(['3']);
    });

    describe('structured token: listid:', () => {
      const listTasks = [
        makeTask({ id: 'l1', sourceListId: 'Backlog', connectorInstanceId: 'Account-A' }),
        makeTask({ id: 'l2', sourceListId: 'backlog', connectorInstanceId: 'account-b' }),
      ];

      it('filters by exact connector and list identity', () => {
        expect(filterTasksByKeyword(listTasks, 'listid:Account-A:Backlog').map(
          (task) => task.id,
        )).toEqual(['l1']);
      });

      it('supports negated exact list identities', () => {
        expect(filterTasksByKeyword(listTasks, '-listid:Account-A:Backlog').map(
          (task) => task.id,
        )).toEqual(['l2']);
      });
    });

    it('list: returns empty for non-matching list', () => {
      const result = filterTasksByKeyword(tasks, 'list:sprint');
      expect(result).toHaveLength(0);
    });
  });

  describe('structured token: assignee:', () => {
    it('filters by assignee: token (substring)', () => {
      const result = filterTasksByKeyword(tasks, 'assignee:octo-org');
      expect(result.map(t => t.id)).toEqual(['3']);
    });

    it('supports none for nullable assignment attributes', () => {
      const nullableTasks = [
        makeTask({ id: 'assigned', assignee: 'alice', sourceListName: 'Backlog', tags: [{
          id: 'tag-1',
          name: 'Feature',
          slug: 'feature',
          type: 'label',
          color: null,
        }] }),
        makeTask({ id: 'unassigned' }),
      ];

      expect(filterTasksByKeyword(nullableTasks, 'assignee:none').map((task) => task.id))
        .toEqual(['unassigned']);
      expect(filterTasksByKeyword(nullableTasks, 'tag:none').map((task) => task.id))
        .toEqual(['unassigned']);
      expect(filterTasksByKeyword(nullableTasks, 'list:none').map((task) => task.id))
        .toEqual(['unassigned']);
    });

    it('supports none and negated none across every unsettable category', () => {
      const selected = makeTask({
        id: 'selected',
        assignee: 'alice',
        dueDate: '2026-08-07',
        priority: 'high',
        sourceListId: 'backlog',
        sourceListName: 'Backlog',
        tags: [{
          id: 'tag-1',
          name: 'Feature',
          slug: 'feature',
          type: 'label',
          color: null,
        }],
        projectPhaseMemberships: [{
          projectId: 'project-1',
          projectName: 'Project 1',
          phaseId: 'phase-1',
          phaseName: 'Delivery',
        }],
      });
      const unset = makeTask({ id: 'unset', priority: 'none' });
      const candidates = [selected, unset];
      const selectedValues: Record<string, string> = {
        assignee: 'alice',
        due: '2026-08-07',
        list: 'backlog',
        phase: 'phase-1',
        priority: 'high',
        project: 'project-1',
        tag: 'feature',
      };

      for (const type of ['assignee', 'due', 'list', 'phase', 'priority', 'project', 'tag']) {
        expect(
          filterTasksByKeyword(candidates, `${type}:none`).map((task) => task.id),
          `${type}:none`,
        ).toEqual(['unset']);
        expect(
          filterTasksByKeyword(candidates, `-${type}:none`).map((task) => task.id),
          `-${type}:none`,
        ).toEqual(['selected']);
        expect(
          filterTasksByKeyword(
            candidates,
            `${type}:${selectedValues[type]} ${type}:none`,
          ).map((task) => task.id),
          `${type}:selected OR ${type}:none`,
        ).toEqual(['selected', 'unset']);
      }
    });

    it('filters by local disposition on the client', () => {
      const dispositionTasks = [
        makeTask({ id: 'active', localDisposition: 'active' }),
        makeTask({ id: 'dismissed', localDisposition: 'dismissed' }),
      ];

      expect(filterTasksByKeyword(dispositionTasks, 'disposition:dismissed').map((task) => task.id))
        .toEqual(['dismissed']);
      expect(filterTasksByKeyword(dispositionTasks, '-disposition:dismissed').map((task) => task.id))
        .toEqual(['active']);
    });

    it('filters project and phase membership, including unassigned values and negation', () => {
      const projectTasks = [
        makeTask({
          id: 'phased',
          projectPhaseMemberships: [{
            projectId: 'Project-A',
            projectName: 'Alpha',
            phaseId: 'Phase-A',
            phaseName: 'Delivery',
          }],
        }),
        makeTask({
          id: 'unphased',
          projectPhaseMemberships: [{
            projectId: 'Project-A',
            projectName: 'Alpha',
            phaseId: null,
            phaseName: null,
          }],
        }),
        makeTask({ id: 'no-project' }),
      ];

      expect(filterTasksByKeyword(projectTasks, 'project:Project-A').map((task) => task.id))
        .toEqual(['phased', 'unphased']);
      expect(filterTasksByKeyword(projectTasks, 'project:none').map((task) => task.id))
        .toEqual(['no-project']);
      expect(filterTasksByKeyword(projectTasks, 'phase:none').map((task) => task.id))
        .toEqual(['unphased', 'no-project']);
      expect(filterTasksByKeyword(projectTasks, '-phase:none').map((task) => task.id))
        .toEqual(['phased']);
    });

    it('assignee: partial match', () => {
      const result = filterTasksByKeyword(tasks, 'assignee:octo');
      expect(result.map(t => t.id)).toEqual(['3']);
    });
  });

  describe('mixed structured and free-text tokens', () => {
    const mixedTasks: Task[] = [
      makeTask({ id: 'm1', title: 'connector alerts', priority: 'high' }),
      makeTask({ id: 'm2', title: 'connector bug', priority: 'low' }),
      makeTask({ id: 'm3', title: 'dashboard alerts', priority: 'high' }),
    ];

    it('applies structured token AND free-text together', () => {
      const result = filterTasksByKeyword(mixedTasks, 'priority:high alerts');
      expect(result.map(t => t.id)).toEqual(['m1', 'm3']);
    });

    it('applies multiple structured tokens together', () => {
      const result = filterTasksByKeyword(mixedTasks, 'priority:high title:connector');
      expect(result.map(t => t.id)).toEqual(['m1']);
    });
  });

  it('ORs included values within a category and ANDs across categories', () => {
    const result = filterTasksByKeyword([
      makeTask({ id: '1', priority: 'high', status: 'todo' }),
      makeTask({ id: '2', priority: 'medium', status: 'todo' }),
      makeTask({ id: '3', priority: 'low', status: 'todo' }),
      makeTask({ id: '4', priority: 'high', status: 'done' }),
    ], 'priority:high priority:medium status:todo');

    expect(result.map((task) => task.id)).toEqual(['1', '2']);
  });

  it('excludes tasks matching negated tokens', () => {
    const result = filterTasksByKeyword(tasks, '-tag:type:bug NOT assignee:octo-org');

    expect(result.map((task) => task.id)).toEqual(['1', '4', '5']);
  });

  it('supports due-date presets and comparisons', () => {
    const result = filterTasksByKeyword([
      makeTask({ id: 'past', dueDate: '2020-01-01' }),
      makeTask({ id: 'future', dueDate: '2099-01-01' }),
      makeTask({ id: 'none', dueDate: null }),
    ], 'due:<2030-01-01');

    expect(result.map((task) => task.id)).toEqual(['past']);
    expect(filterTasksByKeyword(result, '-due:none')).toEqual(result);
  });
});
