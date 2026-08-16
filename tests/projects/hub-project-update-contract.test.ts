import { describe, expect, it } from 'vitest';
import {
  hubProjectRulesChanged,
  parseHubProjectUpdate,
} from '@/lib/projects/hub-project-update';

describe('hub project update contract', () => {
  it('accepts the shared allowlist, trims names, and normalizes rules', () => {
    const result = parseHubProjectUpdate({
      name: '  Project name  ',
      description: null,
      color: '#3b82f6',
      icon: null,
      iconColor: null,
      sourceBindings: [{ connectorInstanceId: 'todo-work', sourceListId: null }],
      autoIncludeRules: [
        { type: 'tag', value: ' #Design ' },
        { type: 'unknown', value: 'discarded' },
      ],
      kanbanColumns: [{
        id: 'todo',
        name: 'To do',
        color: '#3b82f6',
        statusMapping: ['todo'],
      }],
      defaultView: 'board',
      defaultFilters: null,
      statusOverride: 'active',
      hidden: false,
      category: 'Work',
      targetDate: '2026-09-01',
      sortOrder: 2,
      metadata: { owner: 'team' },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.updates.name).toBe('Project name');
    expect(result.updates.autoIncludeRules).toEqual([{ type: 'tag', value: 'Design' }]);
    expect(hubProjectRulesChanged(result.updates)).toBe(true);
  });

  it.each([
    [{ unknownField: true }, 'Unrecognized key'],
    [{ color: 'blue' }, 'Invalid string'],
    [{ hidden: 'yes' }, 'expected boolean'],
    [{ targetDate: '09/01/2026' }, 'Invalid ISO date'],
    [{ targetDate: '2026-02-31' }, 'Invalid ISO date'],
    [{ sourceBindings: [{ connectorInstanceId: '' }] }, 'Too small'],
    [{ kanbanColumns: [{ id: 'todo', name: '', color: '#3b82f6' }] }, 'Too small'],
    [{}, 'No valid fields'],
  ])('rejects invalid update %#', (input, message) => {
    const result = parseHubProjectUpdate(input);
    expect(result).toMatchObject({ success: false });
    if (result.success) return;
    expect(result.message).toContain(message);
  });
});
