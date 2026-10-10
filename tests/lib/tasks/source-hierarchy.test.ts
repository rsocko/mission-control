import { describe, expect, it } from 'vitest';
import {
  canonicalTaskSourceType,
  taskSourceTypesForFilter,
  TYRION_FINANCE_TASK_SOURCE_LIST_ID,
  TYRION_FINANCE_TASK_SOURCE_TYPE,
  withTaskDerivedSourceOptions,
} from '@/lib/tasks/source-hierarchy';

describe('task source hierarchy', () => {
  it('normalizes legacy Mission Control tasks to the Local source', () => {
    expect(canonicalTaskSourceType('mission-control')).toBe('local');
    expect(canonicalTaskSourceType('github-issues')).toBe('github-issues');
  });

  it('derives Tyrion without changing Mission Control lifecycle ownership', () => {
    expect(canonicalTaskSourceType(
      'mission-control',
      TYRION_FINANCE_TASK_SOURCE_LIST_ID,
    )).toBe(TYRION_FINANCE_TASK_SOURCE_TYPE);
    expect(canonicalTaskSourceType('mission-control', 'local')).toBe('local');
  });

  it('includes current and legacy connector types when filtering Local', () => {
    expect(taskSourceTypesForFilter('local')).toEqual(['local', 'mission-control']);
    expect(taskSourceTypesForFilter('mission-control')).toEqual(['local', 'mission-control']);
    expect(taskSourceTypesForFilter('github-issues')).toEqual(['github-issues']);
  });

  it('shows a filterable Tyrion source only when matching tasks exist', () => {
    const sources = [{
      type: 'local',
      name: 'Local',
      icon: 'local',
      notificationOnly: false,
    }];
    expect(withTaskDerivedSourceOptions(sources, {})).toEqual(sources);
    expect(withTaskDerivedSourceOptions(sources, {
      [TYRION_FINANCE_TASK_SOURCE_TYPE]: 2,
    })).toEqual([
      sources[0],
      {
        type: TYRION_FINANCE_TASK_SOURCE_TYPE,
        name: 'Tyrion',
        icon: 'finance',
        notificationOnly: false,
      },
    ]);
  });
});
