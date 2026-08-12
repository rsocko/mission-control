import { describe, expect, it } from 'vitest';
import { buildUniverseGraphSearchParams } from '@/lib/graph/universe-filter-query';
import { normalizeTaskFilterContext } from '@/lib/task-filter-context';

describe('buildUniverseGraphSearchParams', () => {
  it('keeps graph presentation parameters separate from a rich canonical task slice', () => {
    const context = normalizeTaskFilterContext({
      query: 'assignee:alice due:today',
      sources: ['github-issues', 'todoist'],
      listIds: ['github-work:repo-a', 'todoist-home:inbox'],
      listGroupId: 'group-work',
      tagSlugs: ['graph', 'urgent'],
      projectId: 'project-graph',
      priorities: ['critical', 'high'],
      statuses: ['todo', 'in_progress'],
      completion: 'all',
      ageMaxDays: 30,
    });

    const params = buildUniverseGraphSearchParams(
      context,
      ['priority', 'tags', 'project'],
      500,
    );

    expect(params.get('dimensions')).toBe('priority,tags,project');
    expect(params.get('maxNodes')).toBe('500');
    expect(params.get('sources')).toBe('github-issues,todoist');
    expect(params.get('listIds')).toBe('github-work:repo-a,todoist-home:inbox');
    expect(params.get('tagSlugs')).toBe('graph,urgent');
    expect(params.get('filterQuery')).toBe('assignee:alice due:today');
    expect(params.get('projectId')).toBe('project-graph');
    expect(params.get('ageMax')).toBe('30');
    expect(params.has('tf')).toBe(false);
    expect(params.has('layout')).toBe(false);
  });
});
