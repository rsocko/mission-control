// @vitest-environment jsdom

import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NAVIGATION_DESTINATIONS,
  getDestinationResults,
  getProjectResults,
  getSourceListResults,
  readRecentNavigation,
  RECENT_NAVIGATION_KEY,
  saveRecentNavigation,
} from '@/lib/navigation/global-search';

describe('global navigation search', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('ranks exact destination names before alias matches and respects feature gates', () => {
    expect(getDestinationResults('projects')[0]?.title).toBe('Projects');
    expect(getDestinationResults('finance')).toEqual([]);
    expect(getDestinationResults('finance', { financeEnabled: true })[0]).toMatchObject({
      title: 'Money',
      href: '/finance',
    });
  });

  it('only exposes application destinations backed by page routes', () => {
    for (const destination of NAVIGATION_DESTINATIONS.filter(item => item.searchable !== false)) {
      const routeFile = destination.pathname === '/'
        ? path.join(process.cwd(), 'src', 'app', 'page.tsx')
        : path.join(
            process.cwd(),
            'src',
            'app',
            ...destination.pathname.split('/').filter(Boolean),
            'page.tsx',
          );
      const optionalCatchAllRouteFile = path.join(
        path.dirname(routeFile),
        '[[...section]]',
        'page.tsx',
      );
      expect(
        existsSync(routeFile) || existsSync(optionalCatchAllRouteFile),
        `${destination.pathname} should resolve to an application page`,
      ).toBe(true);
    }
  });

  it('creates project results that navigate to encoded project routes', () => {
    expect(getProjectResults('launch', [{
      id: 'launch/project',
      name: 'Launch plan',
      color: '#2563eb',
      appearance: null,
      icon: null,
      category: 'Development',
    }])).toEqual([
      expect.objectContaining({
        type: 'project',
        title: 'Launch plan',
        subtitle: 'Development project',
        href: '/projects/launch%2Fproject',
      }),
    ]);
  });

  it('creates source and list jump URLs from active connector data', () => {
    const results = getSourceListResults(
      'work',
      [{ id: 'todo-work', type: 'microsoft-todo', name: 'Work To Do', enabled: true }],
      [{
        id: 'list-row',
        sourceId: 'work/list',
        connectorInstanceId: 'todo-work',
        name: 'Work queue',
        taskCount: 12,
        groupId: null,
      }],
    );

    expect(results).toEqual([
      expect.objectContaining({
        type: 'list',
        title: 'Work queue',
        id: 'todo-work:work/list',
        href: '/all-tasks?source=microsoft-todo&listId=work%2Flist',
      }),
      expect.objectContaining({
        type: 'source',
        title: 'Work To Do',
        href: '/all-tasks?source=microsoft-todo',
      }),
    ]);
  });

  it('stores only validated, deduplicated navigation records', () => {
    const destination = getDestinationResults('today')[0];
    saveRecentNavigation(destination);
    saveRecentNavigation(destination);

    expect(readRecentNavigation()).toEqual([
      expect.objectContaining({ type: 'destination', id: 'today', href: '/today' }),
    ]);

    localStorage.setItem(RECENT_NAVIGATION_KEY, JSON.stringify([
      { type: 'destination', id: 'unsafe', title: 'Unsafe', subtitle: '', href: '//example.com', iconKey: 'dashboard' },
    ]));
    expect(readRecentNavigation()).toEqual([]);
  });
});
