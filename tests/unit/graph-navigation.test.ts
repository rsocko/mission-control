import { describe, expect, it } from 'vitest';
import {
  buildGraphUniverseHref,
  buildTaskCollectionOriginHref,
  parseGraphOrigin,
  taskFilterContextForEntityCollection,
} from '@/lib/graph/graph-navigation';
import {
  hydrateTaskFilterContext,
  normalizeTaskFilterContext,
  parseTaskFilterContext,
  taskFilterContextForToday,
  taskFilterContextFromSavedView,
} from '@/lib/task-filter-context';

function destination(href: string) {
  return new URL(href, 'https://mission-control.example');
}

describe('Graph collection navigation', () => {
  it('transfers Dashboard filters as stable, shareable canonical URL state', () => {
    const context = normalizeTaskFilterContext({
      query: 'assignee:octo-org release',
      sources: ['github-issues'],
      tagSlugs: ['api'],
      completion: 'all',
    });
    const url = destination(buildGraphUniverseHref({
      context,
      origin: { href: '/?ageMin=30', label: 'Dashboard' },
    }));

    expect(url.pathname).toBe('/graph/universe');
    expect(hydrateTaskFilterContext(url.searchParams).context).toEqual(context);
    expect(parseGraphOrigin(url.searchParams)).toEqual({
      href: '/?ageMin=30',
      label: 'Dashboard',
    });
  });

  it('transfers Today, saved views, and entity collections through canonical adapters', () => {
    const todayUrl = destination(buildGraphUniverseHref({
      context: taskFilterContextForToday('2026-08-01'),
      origin: { href: '/today', label: 'My Day' },
    }));
    expect(hydrateTaskFilterContext(todayUrl.searchParams).context).toMatchObject({
      quickFilter: 'myDay',
      myDayDate: '2026-08-01',
      completion: 'all',
    });

    const saved = taskFilterContextFromSavedView({
      source: 'todoist',
      tag: 'planning',
      showCompleted: 'true',
    });
    const savedUrl = destination(buildGraphUniverseHref({
      context: saved,
      origin: { href: '/', label: 'Planning view' },
    }));
    expect(hydrateTaskFilterContext(savedUrl.searchParams).context).toEqual(saved);

    expect(taskFilterContextForEntityCollection({ type: 'project', id: 'project-1' }).projectId)
      .toBe('project-1');
    expect(taskFilterContextForEntityCollection({
      type: 'list',
      id: 'account:backlog',
      source: 'todoist',
    })).toMatchObject({
      listIds: ['account:backlog'],
      sources: ['todoist'],
    });
    expect(taskFilterContextForEntityCollection({ type: 'listGroup', id: 'work' }).listGroupId)
      .toBe('work');
    expect(taskFilterContextForEntityCollection({ type: 'tag', slug: 'api' }).tagSlugs)
      .toEqual(['api']);
  });

  it('preserves Graph presentation state outside the canonical context', () => {
    const presentation = new URLSearchParams('dimensions=tags,project&camera=120,80&selection=task-1');
    const url = destination(buildGraphUniverseHref({
      context: normalizeTaskFilterContext({ priorities: ['high'] }),
      presentationSearchParams: presentation,
    }));

    expect(url.searchParams.get('dimensions')).toBe('tags,project');
    expect(url.searchParams.get('camera')).toBe('120,80');
    expect(url.searchParams.get('selection')).toBe('task-1');
    expect(parseTaskFilterContext(url.searchParams.get('tf') ?? '').context).not.toHaveProperty('camera');
  });

  it('creates an independent working copy rather than retaining source objects', () => {
    const source = normalizeTaskFilterContext({ tagSlugs: ['api'] });
    const url = destination(buildGraphUniverseHref({ context: source }));
    const transferred = hydrateTaskFilterContext(url.searchParams).context;
    transferred.tagSlugs.push('graph-only');

    expect(source.tagSlugs).toEqual(['api']);
  });

  it('accepts only safe internal origins and rejects stale Graph loops', () => {
    for (const href of [
      'https://evil.example/phish',
      '//evil.example/phish',
      '/\\evil.example/phish',
      '/graph/universe?tf=stale',
      '/graph/universe/',
    ]) {
      const url = destination(buildGraphUniverseHref({
        context: normalizeTaskFilterContext({ tagSlugs: ['api'] }),
        origin: { href, label: 'Unsafe' },
      }));
      expect(parseGraphOrigin(url.searchParams)).toBeNull();
    }

    expect(parseGraphOrigin(new URLSearchParams(
      'from=https%3A%2F%2Fevil.example&fromLabel=Dashboard',
    ))).toBeNull();
  });

  it('builds a reproducible canonical origin for Dashboard back navigation', () => {
    const context = normalizeTaskFilterContext({
      query: 'release',
      listGroupId: 'engineering',
      completion: 'all',
      ageMinDays: 30,
    });
    const href = buildTaskCollectionOriginHref('/matrix?taskId=task-1', context);
    const url = destination(href);

    expect(url.pathname).toBe('/matrix');
    expect(url.searchParams.get('taskId')).toBe('task-1');
    expect(hydrateTaskFilterContext(url.searchParams).context).toEqual(context);
  });
});
