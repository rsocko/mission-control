import { describe, expect, it } from 'vitest';
import {
  canonicalTaskSourceType,
  taskSourceTypesForFilter,
} from '@/lib/tasks/source-hierarchy';

describe('task source hierarchy', () => {
  it('normalizes legacy Mission Control tasks to the Local source', () => {
    expect(canonicalTaskSourceType('mission-control')).toBe('local');
    expect(canonicalTaskSourceType('github-issues')).toBe('github-issues');
  });

  it('includes current and legacy connector types when filtering Local', () => {
    expect(taskSourceTypesForFilter('local')).toEqual(['local', 'mission-control']);
    expect(taskSourceTypesForFilter('mission-control')).toEqual(['local', 'mission-control']);
    expect(taskSourceTypesForFilter('github-issues')).toEqual(['github-issues']);
  });
});
