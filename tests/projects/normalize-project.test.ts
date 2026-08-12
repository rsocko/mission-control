import { describe, expect, it } from 'vitest';
import {
  normalizeProjectJsonCollections,
  resolveProjectIconColor,
} from '@/lib/projects/normalize-project';

describe('resolveProjectIconColor', () => {
  it('uses the project color when an icon color was not persisted', () => {
    expect(resolveProjectIconColor(null, '#f59e0b')).toBe('#f59e0b');
  });

  it('preserves an explicitly selected icon color', () => {
    expect(resolveProjectIconColor('#8b5cf6', '#f59e0b')).toBe('#8b5cf6');
  });

  it('returns undefined when neither color is available', () => {
    expect(resolveProjectIconColor(null, null)).toBeUndefined();
  });
});

describe('normalizeProjectJsonCollections', () => {
  it('preserves project JSON collections that are already arrays', () => {
    const project = {
      id: 'project-1',
      sourceBindings: [{ connectorId: 'github-1' }],
      autoIncludeRules: [{ type: 'tag', value: 'homelab' }],
      kanbanColumns: [{ id: 'todo' }],
    };

    expect(normalizeProjectJsonCollections(project)).toEqual(project);
  });

  it('decodes legacy double-encoded JSON collections', () => {
    expect(normalizeProjectJsonCollections({
      id: 'gh-project:github-1:1',
      sourceBindings: '[{"connectorId":"github-1"}]',
      autoIncludeRules: '[]',
      kanbanColumns: '[{"id":"todo"}]',
    })).toEqual({
      id: 'gh-project:github-1:1',
      sourceBindings: [{ connectorId: 'github-1' }],
      autoIncludeRules: [],
      kanbanColumns: [{ id: 'todo' }],
    });
  });

  it('uses empty collections for invalid legacy values', () => {
    expect(normalizeProjectJsonCollections({
      id: 'project-1',
      sourceBindings: null,
      autoIncludeRules: '{"type":"tag"}',
      kanbanColumns: 'not-json',
    })).toEqual({
      id: 'project-1',
      sourceBindings: [],
      autoIncludeRules: [],
      kanbanColumns: [],
    });
  });
});
