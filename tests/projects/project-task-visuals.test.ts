import { describe, expect, it } from 'vitest';
import {
  getProjectTaskConnectorIcon,
  getProjectTaskPriorityColor,
  PROJECT_TASK_PRIORITY_LABELS,
} from '@/lib/projects/task-visuals';

describe('shared project task visuals', () => {
  it('provides the canonical priority labels and colors', () => {
    expect(PROJECT_TASK_PRIORITY_LABELS).toEqual({
      critical: 'P0',
      high: 'P1',
      medium: 'P2',
      low: 'P3',
      none: '—',
    });
    expect(getProjectTaskPriorityColor('critical')).toBe('#f43f5e');
    expect(getProjectTaskPriorityColor('low')).toBe('#38bdf8');
    expect(getProjectTaskPriorityColor('none')).toBe('#64748b');
  });

  it.each([
    ['local', 'LocalSourceIcon'],
    ['github-issues', 'FolderGit2'],
    ['microsoft-todo', 'ListTodo'],
    ['ms-todo', 'ListTodo'],
    ['unknown', 'ListChecks'],
  ])('maps %s to the canonical project connector icon', (connectorType, name) => {
    const icon = getProjectTaskConnectorIcon(connectorType);
    expect(icon.displayName || icon.name).toContain(name);
  });
});
