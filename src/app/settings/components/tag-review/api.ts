import type { MergeMode } from './types';

export type TagApiOperation =
  | 'load'
  | 'confirm'
  | 'rename'
  | 'recolor'
  | 'delete'
  | 'merge'
  | 'push'
  | 'remove-from-source';

const FALLBACK_ERRORS: Record<TagApiOperation, string> = {
  load: 'Failed to load tags',
  confirm: 'Failed to confirm tag',
  rename: 'Failed to rename tag',
  recolor: 'Failed to update color',
  delete: 'Failed to remove tag',
  merge: 'Merge failed',
  push: 'Failed to push tag',
  'remove-from-source': 'Source removal failed',
};

const REFRESH_AFTER = new Set<TagApiOperation>(['merge', 'push']);

export class TagApiError extends Error {
  constructor(
    readonly operation: TagApiOperation,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TagApiError';
  }
}

export function shouldRefreshAfter(operation: TagApiOperation): boolean {
  return REFRESH_AFTER.has(operation);
}

export function mapTagApiError(operation: TagApiOperation, error?: unknown): string {
  if ((operation === 'merge' || operation === 'push') && error instanceof Error) {
    return `${FALLBACK_ERRORS[operation]}: ${error.message}`;
  }
  return FALLBACK_ERRORS[operation];
}

export async function requestTagApi<T>(
  operation: TagApiOperation,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw new TagApiError(operation, error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new TagApiError(operation, body.error || `HTTP ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const tagReviewApi = {
  load: () => requestTagApi<{ tags?: unknown[]; sourceTagSlugs?: unknown[] }>(
    'load',
    '/api/tags?includeListUsage=true',
  ),
  connectors: () => requestTagApi<{ connectors?: unknown[]; sourceLists?: unknown[] }>(
    'load',
    '/api/connectors',
  ),
  patch: (operation: 'confirm' | 'rename' | 'recolor', body: unknown) =>
    requestTagApi<Record<string, unknown>>(operation, '/api/tags', jsonRequest('PATCH', body)),
  delete: (tagId: string) =>
    requestTagApi<Record<string, unknown>>(
      'delete',
      `/api/tags?id=${encodeURIComponent(tagId)}`,
      { method: 'DELETE' },
    ),
  merge: (mode: MergeMode, sourceTagIds: string[], targetTagId: string) =>
    requestTagApi<Record<string, number>>(
      'merge',
      mode === 'unify' ? '/api/tags/unify' : '/api/tags/merge',
      jsonRequest('POST', { sourceTagIds, targetTagId }),
    ),
  push: (tagId: string, sourceListId: string) =>
    requestTagApi<Record<string, unknown>>(
      'push',
      '/api/tags/push',
      jsonRequest('POST', { tagId, sourceListId }),
    ),
  removeFromSource: (tagId: string) =>
    requestTagApi<{ removed?: number; errors?: unknown[] }>(
      'remove-from-source',
      '/api/tags/remove-from-source',
      jsonRequest('POST', { tagId }),
    ),
};
