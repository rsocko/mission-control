import {
  normalizeTaskFilterContext,
  setTaskFilterContextInSearchParams,
  type TaskFilterContext,
} from '@/lib/task-filter-context';

export const GRAPH_UNIVERSE_PATH = '/graph/universe';
export const GRAPH_ORIGIN_PARAM = 'from';
export const GRAPH_ORIGIN_LABEL_PARAM = 'fromLabel';

export interface GraphOrigin {
  href: string;
  label: string;
}

interface BuildGraphUniverseHrefOptions {
  context: TaskFilterContext;
  origin?: GraphOrigin | null;
  presentationSearchParams?: URLSearchParams;
}

export function buildGraphUniverseHref({
  context,
  origin,
  presentationSearchParams,
}: BuildGraphUniverseHrefOptions): string {
  const initial = new URLSearchParams(presentationSearchParams?.toString());
  initial.delete(GRAPH_ORIGIN_PARAM);
  initial.delete(GRAPH_ORIGIN_LABEL_PARAM);

  const params = setTaskFilterContextInSearchParams(initial, {
    ...normalizeTaskFilterContext(context),
  });
  const safeOrigin = origin ? normalizeGraphOrigin(origin) : null;
  if (safeOrigin) {
    params.set(GRAPH_ORIGIN_PARAM, safeOrigin.href);
    params.set(GRAPH_ORIGIN_LABEL_PARAM, safeOrigin.label);
  }

  return params.size ? `${GRAPH_UNIVERSE_PATH}?${params.toString()}` : GRAPH_UNIVERSE_PATH;
}

export function buildTaskCollectionOriginHref(
  href: string,
  context: TaskFilterContext,
): string {
  const safeHref = normalizeInternalHref(href);
  if (!safeHref) return '/';

  const parsed = new URL(safeHref, 'https://mission-control.example');
  const params = setTaskFilterContextInSearchParams(parsed.searchParams, context);
  return `${parsed.pathname}${params.size ? `?${params.toString()}` : ''}${parsed.hash}`;
}

export function parseGraphOrigin(searchParams: Pick<URLSearchParams, 'get'>): GraphOrigin | null {
  const href = searchParams.get(GRAPH_ORIGIN_PARAM);
  const label = searchParams.get(GRAPH_ORIGIN_LABEL_PARAM);
  return href && label ? normalizeGraphOrigin({ href, label }) : null;
}

export function taskFilterContextForEntityCollection(
  collection:
    | { type: 'source'; id: string }
    | { type: 'list'; id: string; source?: string | null }
    | { type: 'listGroup'; id: string; source?: string | null }
    | { type: 'tag'; slug: string }
    | { type: 'project'; id: string },
): TaskFilterContext {
  switch (collection.type) {
    case 'source':
      return normalizeTaskFilterContext({ sources: [collection.id] });
    case 'list':
      return normalizeTaskFilterContext({
        listIds: [collection.id],
        sources: collection.source ? [collection.source] : [],
      });
    case 'listGroup':
      return normalizeTaskFilterContext({
        listGroupId: collection.id,
        sources: collection.source ? [collection.source] : [],
      });
    case 'tag':
      return normalizeTaskFilterContext({ tagSlugs: [collection.slug] });
    case 'project':
      return normalizeTaskFilterContext({ projectId: collection.id });
  }
}

function normalizeGraphOrigin(origin: GraphOrigin): GraphOrigin | null {
  const href = normalizeInternalHref(origin.href);
  const label = origin.label.replaceAll(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return href && label ? { href, label } : null;
}

function normalizeInternalHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) return null;

  try {
    const parsed = new URL(trimmed, 'https://mission-control.example');
    if (parsed.origin !== 'https://mission-control.example') return null;
    const canonicalPathname = parsed.pathname.replace(/\/+$/, '') || '/';
    if (canonicalPathname === GRAPH_UNIVERSE_PATH) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
