import type { HubProjectSummaryDto } from '@/types/api';
import type { SourceList } from '@/types/dashboard';

export type NavigationFeature = 'aiEnabled' | 'financeEnabled';
export type NavigationIconKey =
  | 'activity'
  | 'bell'
  | 'calendar'
  | 'capture'
  | 'columns'
  | 'dashboard'
  | 'docs'
  | 'finance'
  | 'goals'
  | 'graph'
  | 'houston'
  | 'inbox'
  | 'list'
  | 'projects'
  | 'quick-sort'
  | 'reconciliation'
  | 'routines'
  | 'settings'
  | 'source';

export type MobileRouteAccess = 'listed' | 'hidden' | 'unsupported';

export interface NavigationDestination {
  id: string;
  pathname: string;
  title: string;
  searchLabel: string;
  description: string;
  aliases: readonly string[];
  iconKey: NavigationIconKey;
  mobileAccess: MobileRouteAccess;
  unsupportedReason?: string;
  feature?: NavigationFeature;
  suggested?: boolean;
  searchable?: boolean;
}

export interface SearchFeatures {
  aiEnabled?: boolean;
  financeEnabled?: boolean;
}

export interface SearchConnector {
  id: string;
  type: string;
  name: string;
  enabled?: boolean;
  deletedAt?: string | null;
}

export type GlobalSearchResultType = 'destination' | 'project' | 'source' | 'list';

export interface GlobalSearchResult {
  type: GlobalSearchResultType;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  iconKey: NavigationIconKey;
  keywords?: readonly string[];
}

export interface RecentNavigationResult {
  type: GlobalSearchResultType;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  iconKey: NavigationIconKey;
}

export const RECENT_NAVIGATION_KEY = 'mc:recent-navigation';
export const MAX_RECENT_NAVIGATION = 5;

export const NAVIGATION_DESTINATIONS: readonly NavigationDestination[] = [
  {
    id: 'dashboard',
    pathname: '/',
    title: 'Dashboard',
    searchLabel: 'Dashboard',
    description: 'Open the main dashboard',
    aliases: ['home', 'overview'],
    iconKey: 'dashboard',
    mobileAccess: 'listed',
    suggested: true,
  },
  {
    id: 'today',
    pathname: '/today',
    title: 'Today',
    searchLabel: 'Today',
    description: 'Plan and work today’s tasks',
    aliases: ['my day', 'daily plan'],
    iconKey: 'calendar',
    mobileAccess: 'listed',
    suggested: true,
  },
  {
    id: 'all-tasks',
    pathname: '/all-tasks',
    title: 'All Tasks',
    searchLabel: 'All Tasks',
    description: 'Browse and filter every task',
    aliases: ['tasks', 'work'],
    iconKey: 'list',
    mobileAccess: 'listed',
    suggested: true,
  },
  {
    id: 'projects',
    pathname: '/projects',
    title: 'Projects',
    searchLabel: 'Projects',
    description: 'Browse every active project',
    aliases: ['portfolio', 'plans'],
    iconKey: 'projects',
    mobileAccess: 'listed',
    suggested: true,
  },
  {
    id: 'kanban',
    pathname: '/kanban',
    title: 'Kanban',
    searchLabel: 'Kanban',
    description: 'Move work across status columns',
    aliases: ['board', 'columns'],
    iconKey: 'columns',
    mobileAccess: 'unsupported',
    unsupportedReason: 'Kanban needs the extra screen space for columns and drag-and-drop.',
    suggested: true,
  },
  {
    id: 'goals',
    pathname: '/goals',
    title: 'Goals',
    searchLabel: 'Goals',
    description: 'Develop goals and ideas',
    aliases: ['ideas', 'aspirations'],
    iconKey: 'goals',
    mobileAccess: 'listed',
  },
  {
    id: 'timeline',
    pathname: '/timeline',
    title: 'Timeline',
    searchLabel: 'Timeline',
    description: 'Review scheduled work',
    aliases: ['calendar', 'roadmap', 'schedule'],
    iconKey: 'calendar',
    mobileAccess: 'unsupported',
    unsupportedReason: 'Timeline needs the extra screen space for its calendar and upcoming-task panels.',
  },
  {
    id: 'notifications',
    pathname: '/notifications',
    title: 'Notifications',
    searchLabel: 'Notifications',
    description: 'Review activity and alerts',
    aliases: ['alerts', 'updates'],
    iconKey: 'bell',
    mobileAccess: 'listed',
    suggested: true,
  },
  {
    id: 'routines',
    pathname: '/routines',
    title: 'Routines',
    searchLabel: 'Routines',
    description: 'Open daily routines',
    aliases: ['habits', 'recurring'],
    iconKey: 'routines',
    mobileAccess: 'listed',
  },
  {
    id: 'triage',
    pathname: '/triage',
    title: 'Inbox',
    searchLabel: 'Triage',
    description: 'Review and route incoming items',
    aliases: ['inbox', 'queue'],
    iconKey: 'inbox',
    mobileAccess: 'listed',
  },
  {
    id: 'reconciliation',
    pathname: '/scout/reconciliation',
    title: 'Reconciliation',
    searchLabel: 'Reconciliation',
    description: 'Review Scout status suggestions',
    aliases: ['scout', 'resolve'],
    iconKey: 'reconciliation',
    mobileAccess: 'listed',
  },
  {
    id: 'quick-sort',
    pathname: '/quick-sort',
    title: 'Sort',
    searchLabel: 'Quick Sort',
    description: 'Rapidly organize pending work',
    aliases: ['sort', 'organize'],
    iconKey: 'quick-sort',
    mobileAccess: 'listed',
  },
  {
    id: 'insights',
    pathname: '/insights',
    title: 'Insights',
    searchLabel: 'Insights',
    description: 'Review productivity insights',
    aliases: ['analytics', 'reports'],
    iconKey: 'activity',
    mobileAccess: 'listed',
  },
  {
    id: 'graph',
    pathname: '/graph',
    title: 'Graph',
    searchLabel: 'Graph',
    description: 'Explore connected work',
    aliases: ['relationships', 'network'],
    iconKey: 'graph',
    mobileAccess: 'listed',
  },
  {
    id: 'capture',
    pathname: '/capture',
    title: 'Capture',
    searchLabel: 'Capture',
    description: 'Capture a new item',
    aliases: ['add', 'new'],
    iconKey: 'capture',
    mobileAccess: 'listed',
  },
  {
    id: 'houston',
    pathname: '/ai',
    title: 'Houston',
    searchLabel: 'Houston',
    description: 'Open the AI assistant',
    aliases: ['ai', 'assistant'],
    iconKey: 'houston',
    mobileAccess: 'listed',
    feature: 'aiEnabled',
  },
  {
    id: 'docs',
    pathname: '/doc-intelligence',
    title: 'Docs',
    searchLabel: 'Docs',
    description: 'Review document intelligence',
    aliases: ['documents', 'files'],
    iconKey: 'docs',
    mobileAccess: 'hidden',
  },
  {
    id: 'finance',
    pathname: '/finance',
    title: 'Money',
    searchLabel: 'Money',
    description: 'Review financial activity',
    aliases: ['finance', 'spending'],
    iconKey: 'finance',
    mobileAccess: 'listed',
    feature: 'financeEnabled',
  },
  {
    id: 'settings',
    pathname: '/settings',
    title: 'Settings',
    searchLabel: 'Settings',
    description: 'Configure Mission Control',
    aliases: ['preferences', 'configure'],
    iconKey: 'settings',
    mobileAccess: 'listed',
  },
  {
    id: 'matrix',
    pathname: '/matrix',
    title: 'Priority Matrix',
    searchLabel: 'Priority Matrix',
    description: 'Compare tasks by urgency and importance',
    aliases: ['eisenhower', 'priority'],
    iconKey: 'columns',
    mobileAccess: 'hidden',
  },
  {
    id: 'more',
    pathname: '/more',
    title: 'More',
    searchLabel: 'More',
    description: 'Open additional mobile destinations',
    aliases: [],
    iconKey: 'list',
    mobileAccess: 'listed',
    searchable: false,
  },
] as const;

function isFeatureAvailable(
  feature: NavigationFeature | undefined,
  features: SearchFeatures | null | undefined,
): boolean {
  return !feature || features?.[feature] === true;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matchScore(query: string, title: string, keywords: readonly string[]): number | null {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;

  const normalizedTitle = normalize(title);
  if (normalizedTitle === normalizedQuery) return 0;
  if (normalizedTitle.startsWith(normalizedQuery)) return 1;
  if (normalizedTitle.split(/\s+/).some(word => word.startsWith(normalizedQuery))) return 2;
  if (normalizedTitle.includes(normalizedQuery)) return 3;

  const keywordIndex = keywords.findIndex(keyword => normalize(keyword).includes(normalizedQuery));
  return keywordIndex >= 0 ? 4 + keywordIndex / 100 : null;
}

function rankedMatches(
  query: string,
  results: readonly GlobalSearchResult[],
  limit: number,
): GlobalSearchResult[] {
  return results
    .map(result => ({ result, score: matchScore(query, result.title, result.keywords ?? []) }))
    .filter((entry): entry is { result: GlobalSearchResult; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.result.title.localeCompare(b.result.title))
    .slice(0, limit)
    .map(entry => entry.result);
}

export function getDestinationResults(
  query: string,
  features?: SearchFeatures | null,
  options: { suggestedOnly?: boolean; limit?: number } = {},
): GlobalSearchResult[] {
  const destinations = NAVIGATION_DESTINATIONS
    .filter(destination => destination.searchable !== false)
    .filter(destination => isFeatureAvailable(destination.feature, features))
    .filter(destination => !options.suggestedOnly || destination.suggested)
    .map<GlobalSearchResult>(destination => ({
      type: 'destination',
      id: destination.id,
      title: destination.searchLabel,
      subtitle: destination.description,
      href: destination.pathname,
      iconKey: destination.iconKey,
      keywords: destination.aliases,
    }));

  return query.trim()
    ? rankedMatches(query, destinations, options.limit ?? 6)
    : destinations.slice(0, options.limit ?? 6);
}

export function getProjectResults(
  query: string,
  projects: readonly HubProjectSummaryDto[],
  limit = 5,
): GlobalSearchResult[] {
  if (!query.trim()) return [];

  return rankedMatches(
    query,
    projects
      .filter(project => !project.hidden)
      .map(project => ({
        type: 'project',
        id: project.id,
        title: project.name,
        subtitle: project.category ? `${project.category} project` : 'Project',
        href: `/projects/${encodeURIComponent(project.id)}`,
        iconKey: 'projects',
        keywords: project.category ? [project.category] : [],
      })),
    limit,
  );
}

export function getSourceListResults(
  query: string,
  connectors: readonly SearchConnector[],
  sourceLists: readonly SourceList[],
  limit = 7,
): GlobalSearchResult[] {
  if (!query.trim()) return [];

  const activeConnectors = connectors.filter(connector => (
    connector.enabled !== false && !connector.deletedAt
  ));
  const connectorById = new Map(activeConnectors.map(connector => [connector.id, connector]));
  const uniqueSourceTypes = new Set<string>();
  const results: GlobalSearchResult[] = [];

  for (const connector of activeConnectors) {
    if (uniqueSourceTypes.has(connector.type)) continue;
    uniqueSourceTypes.add(connector.type);
    const listCount = sourceLists.filter(list => (
      list.connectorInstanceId === connector.id && !list.hidden
    )).length;
    results.push({
      type: 'source',
      id: connector.type,
      title: connector.name,
      subtitle: `Source${listCount ? ` · ${listCount} ${listCount === 1 ? 'list' : 'lists'}` : ''}`,
      href: `/all-tasks?source=${encodeURIComponent(connector.type)}`,
      iconKey: 'source',
      keywords: [connector.type],
    });
  }

  for (const list of sourceLists) {
    if (list.hidden) continue;
    const connector = connectorById.get(list.connectorInstanceId);
    if (!connector) continue;
    const listId = `${list.connectorInstanceId}:${list.sourceId}`;
    const params = new URLSearchParams({
      source: connector.type,
      listId,
    });
    results.push({
      type: 'list',
      id: listId,
      title: list.name,
      subtitle: `${connector.name} · ${list.taskCount} ${list.taskCount === 1 ? 'task' : 'tasks'}`,
      href: `/all-tasks?${params.toString()}`,
      iconKey: 'list',
      keywords: [connector.name, connector.type],
    });
  }

  return rankedMatches(query, results, limit);
}

function isRecentNavigationResult(value: unknown): value is RecentNavigationResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RecentNavigationResult>;
  return (
    ['destination', 'project', 'source', 'list'].includes(candidate.type ?? '')
    && typeof candidate.id === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.subtitle === 'string'
    && typeof candidate.href === 'string'
    && candidate.href.startsWith('/')
    && !candidate.href.startsWith('//')
    && !candidate.href.includes('\\')
    && typeof candidate.iconKey === 'string'
  );
}

export function readRecentNavigation(): RecentNavigationResult[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_NAVIGATION_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(isRecentNavigationResult).slice(0, MAX_RECENT_NAVIGATION)
      : [];
  } catch {
    return [];
  }
}

export function saveRecentNavigation(result: GlobalSearchResult): RecentNavigationResult[] {
  if (typeof window === 'undefined') return [];
  const recent: RecentNavigationResult = {
    type: result.type,
    id: result.id,
    title: result.title,
    subtitle: result.subtitle,
    href: result.href,
    iconKey: result.iconKey,
  };
  const next = [
    recent,
    ...readRecentNavigation().filter(item => (
      item.type !== result.type || item.id !== result.id
    )),
  ].slice(0, MAX_RECENT_NAVIGATION);

  try {
    localStorage.setItem(RECENT_NAVIGATION_KEY, JSON.stringify(next));
  } catch {
    return [];
  }
  return next;
}
