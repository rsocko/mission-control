import { describe, expect, it } from 'vitest';
import {
  extractWikiLinks,
  getIdeationRelationshipTargetLabels,
  getIdeationPropertySuggestions,
  parseIdeationProperty,
  parseIdeationTitleTokens,
} from '@/lib/ideation/property-parser';

describe('parseIdeationProperty', () => {
  it('parses supported enum and numeric properties', () => {
    expect(parseIdeationProperty('priority:: high').property).toEqual({
      key: 'priority',
      rawValue: 'high',
      value: 'high',
    });
    expect(parseIdeationProperty('status:: in progress').property?.value).toBe('in_progress');
    expect(parseIdeationProperty('effort:: 4').property?.value).toBe(4);
  });

  it('parses natural-language dates and tag lists', () => {
    expect(parseIdeationProperty('due:: next friday').property?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseIdeationProperty('tags:: #backend, graph').property?.value).toEqual([
      'backend',
      'graph',
    ]);
  });

  it('requires wiki-links for dependencies', () => {
    expect(extractWikiLinks('[[First task]] and [[Second task]]')).toEqual([
      'First task',
      'Second task',
    ]);
    expect(parseIdeationProperty('depends-on:: First task').property).toBeNull();
    expect(parseIdeationProperty('depends-on:: [[First task]]').property?.value).toEqual([
      'First task',
    ]);
    expect(parseIdeationProperty('related:: [[First task]]').property?.key).toBe('related');
  });

  it('offers only other task nodes as relationship targets', () => {
    const base = {
      parentId: 'root',
      sortOrder: 0,
      properties: {},
    };
    expect(getIdeationRelationshipTargetLabels([
      { ...base, id: 'current', label: 'Current task', kind: 'task' },
      { ...base, id: 'task', label: 'Task target', kind: 'task' },
      { ...base, id: 'phase', label: 'Phase target', kind: 'phase' },
      { ...base, id: 'idea', label: 'Idea target', kind: 'idea' },
    ], 'current')).toEqual(['Task target']);
  });

  it('supports freeform assignees and explicitly defers duplicate relationships', () => {
    expect(parseIdeationProperty('assignee:: me').property?.value).toBe('me');
    expect(parseIdeationProperty('duplicates:: [[Old task]]').error).toContain('not supported');
  });

  it('extracts safe title accelerators without consuming ordinary punctuation', () => {
    expect(parseIdeationTitleTokens('Fix auth bug !urgent #backend #api')).toEqual({
      label: 'Fix auth bug',
      properties: [
        { key: 'priority', rawValue: 'critical', value: 'critical' },
        { key: 'tags', rawValue: '#backend, #api', value: ['backend', 'api'] },
      ],
    });
    expect(parseIdeationTitleTokens('Document C# API')).toEqual({
      label: 'Document C# API',
      properties: [],
    });
  });

  it('suggests property names and enum values', () => {
    expect(getIdeationPropertySuggestions('pri')[0]?.value).toBe('priority:: ');
    expect(getIdeationPropertySuggestions('status:: in')[0]?.value).toBe('status:: in_progress');
  });

  it('rejects unknown and invalid property values', () => {
    expect(parseIdeationProperty('owner:: me').error).toContain('Unknown property');
    expect(parseIdeationProperty('effort:: 9').error).toContain('1 to 5');
    expect(parseIdeationProperty('priority high').error).toContain('key:: value');
  });
});
