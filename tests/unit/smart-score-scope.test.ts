import { describe, expect, it } from 'vitest';
import {
  buildOverallSmartScoreSpec,
  describeSmartScoreScope,
  isOverallSmartScoreScope,
} from '@/lib/tasks/core/smart-score-scope';
import type { TaskFilterSpec } from '@/lib/tasks/core/contracts';

function makeSpec(overrides: Partial<TaskFilterSpec> = {}): TaskFilterSpec {
  return {
    connectorTypes: [],
    statuses: [],
    priorities: [],
    planningHorizons: [],
    planningHorizonIsNull: false,
    localDispositions: ['active'],
    excludeClosedStatuses: false,
    openOnly: false,
    parentOnly: false,
    sourceListIds: [],
    sourceListGroupId: null,
    createdAtMax: null,
    createdAtMin: null,
    filterQuery: null,
    tagSlug: null,
    tagSlugs: [],
    projectId: null,
    quickFilter: null,
    myDayDate: '2026-10-16',
    today: '2026-10-16',
    weekFromNow: '2026-10-23',
    recentCutoff: '2026-10-09',
    ...overrides,
  };
}

describe('Smart Score scope', () => {
  it('recognizes and labels the all-open-task scope', () => {
    const spec = makeSpec({
      openOnly: true,
      excludeClosedStatuses: true,
      parentOnly: true,
    });

    expect(isOverallSmartScoreScope(spec)).toBe(true);
    expect(describeSmartScoreScope(spec, [])).toBe('all open tasks');
  });

  it('recognizes explicit todo and in-progress statuses as all open tasks', () => {
    const spec = makeSpec({ statuses: ['todo', 'in_progress'] });

    expect(isOverallSmartScoreScope(spec)).toBe(true);
    expect(describeSmartScoreScope(spec, [])).toBe('all open tasks');
  });

  it('uses a project name for contextual ranking', () => {
    const spec = makeSpec({
      projectId: 'project-1',
      openOnly: true,
      excludeClosedStatuses: true,
    });
    const row = {
      projectPhaseMemberships: [{
        projectId: 'project-1',
        projectName: 'Homelab',
        phaseId: null,
        phaseName: null,
      }],
    };

    expect(describeSmartScoreScope(
      spec,
      [row as Parameters<typeof describeSmartScoreScope>[1][number]],
    )).toBe('Homelab');
  });

  it('removes contextual filters without changing parent-task visibility', () => {
    const overall = buildOverallSmartScoreSpec(makeSpec({
      projectId: 'project-1',
      priorities: ['critical'],
      quickFilter: 'myDay',
      parentOnly: true,
      search: 'backup',
    }));

    expect(overall).toMatchObject({
      projectId: null,
      priorities: [],
      quickFilter: null,
      parentOnly: true,
      search: null,
      openOnly: true,
      excludeClosedStatuses: true,
    });
    expect(isOverallSmartScoreScope(overall)).toBe(true);
  });
});
