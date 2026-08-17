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
    expect(getProjectTaskPriorityColor('critical')).toBe('var(--danger)');
    expect(getProjectTaskPriorityColor('low')).toBe('var(--text-secondary)');
    expect(getProjectTaskPriorityColor('none')).toBe('var(--border-strong)');
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
