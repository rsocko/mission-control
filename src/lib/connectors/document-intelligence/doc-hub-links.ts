/**
 * Deep link URL generation for the OWL frontend.
 *
 * OWL frontend routes use a HashRouter:
 *   /#/action-queue              – action queue
 *   /#/eob?tab=unmatched         – unmatched EOB queue
 *   /#/statements                – statement tracker
 *   /#/metadata/{doc_id}         – document metadata detail
 */

export type DocHubLinkType = 'action' | 'eob' | 'statement' | 'document';

export interface DocHubLinkOptions {
  /** DI Hub base URL (e.g. http://localhost:8200) */
  baseUrl: string;
  /** Type of admin page to link to */
  type: DocHubLinkType;
  /** Resource ID (action_id, eob_id, or doc_id). Not required for 'statement'. */
  id?: string | number;
}

const LEGACY_ROUTE_MAPPINGS: Array<{
  pattern: RegExp;
  buildHash: (match: RegExpMatchArray) => string;
}> = [
  { pattern: /\/admin\/actions\/[^/]+$/, buildHash: () => '#/action-queue' },
  { pattern: /\/admin\/eob\/[^/]+$/, buildHash: () => '#/eob?tab=unmatched' },
  { pattern: /\/admin\/statements$/, buildHash: () => '#/statements' },
  {
    pattern: /\/admin\/documents\/([^/]+)$/,
    buildHash: (match) => `#/metadata/${match[1]}`,
  },
];

/**
 * Upgrade deep links persisted before OWL moved from server-rendered admin
 * pages to its HashRouter frontend.
 */
export function normalizeDocHubUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    for (const mapping of LEGACY_ROUTE_MAPPINGS) {
      const match = url.pathname.match(mapping.pattern);
      if (!match) continue;

      const basePath = url.pathname.slice(0, match.index);
      url.pathname = `${basePath}/`;
      url.search = '';
      url.hash = mapping.buildHash(match);
      return url.toString();
    }
  } catch {
    return value;
  }

  return value;
}

/**
 * Build an OWL frontend deep link URL.
 * Returns the full URL string, or null if required params are missing.
 */
export function buildDocHubUrl(options: DocHubLinkOptions): string | null {
  const { baseUrl, type, id } = options;

  if (!baseUrl) return null;

  const cleanBase = baseUrl.replace(/\/+$/, '');

  switch (type) {
    case 'action':
      if (!id) return null;
      return `${cleanBase}/#/action-queue`;
    case 'eob':
      if (!id) return null;
      return `${cleanBase}/#/eob?tab=unmatched`;
    case 'statement':
      return `${cleanBase}/#/statements`;
    case 'document':
      if (!id) return null;
      return `${cleanBase}/#/metadata/${encodeURIComponent(String(id))}`;
    default:
      return null;
  }
}

/**
 * Build a DI Hub URL for a task (action queue item).
 * Generates both the action link and document link.
 */
export function buildDocHubTaskLinks(
  baseUrl: string,
  actionId: string,
  documentId?: number | string,
): { actionUrl: string | null; documentUrl: string | null } {
  return {
    actionUrl: buildDocHubUrl({ baseUrl, type: 'action', id: actionId }),
    documentUrl: documentId
      ? buildDocHubUrl({ baseUrl, type: 'document', id: documentId })
      : null,
  };
}

/**
 * Build a DI Hub URL for an EOB alert.
 */
export function buildDocHubEobUrl(baseUrl: string, eobId: string | number): string | null {
  return buildDocHubUrl({ baseUrl, type: 'eob', id: eobId });
}

/**
 * Build a DI Hub URL for the statement tracker.
 */
export function buildDocHubStatementsUrl(baseUrl: string): string | null {
  return buildDocHubUrl({ baseUrl, type: 'statement' });
}
