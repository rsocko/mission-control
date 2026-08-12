/**
 * Deep link URL generation for the Document Intelligence Hub admin UI.
 *
 * DI Hub admin routes:
 *   /admin/actions/{action_id}   – action detail
 *   /admin/eob/{eob_id}          – EOB match details
 *   /admin/statements            – statement tracker
 *   /admin/documents/{doc_id}    – document detail with OCR view
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

/**
 * Build a DI Hub admin deep link URL.
 * Returns the full URL string, or null if required params are missing.
 */
export function buildDocHubUrl(options: DocHubLinkOptions): string | null {
  const { baseUrl, type, id } = options;

  if (!baseUrl) return null;

  const cleanBase = baseUrl.replace(/\/$/, '');

  switch (type) {
    case 'action':
      if (!id) return null;
      return `${cleanBase}/admin/actions/${encodeURIComponent(String(id))}`;
    case 'eob':
      if (!id) return null;
      return `${cleanBase}/admin/eob/${encodeURIComponent(String(id))}`;
    case 'statement':
      return `${cleanBase}/admin/statements`;
    case 'document':
      if (!id) return null;
      return `${cleanBase}/admin/documents/${encodeURIComponent(String(id))}`;
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
