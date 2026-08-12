/**
 * Extracts a human-readable external ID for tasks from providers
 * where the ID is meaningful (e.g. GitHub issue numbers).
 *
 * Returns null for providers where IDs are opaque/internal
 * (e.g. Microsoft To-Do, local tasks).
 */
export function getTaskDisplayId(
  connectorType: string,
  metadata?: unknown,
  sourceId?: string | null,
): string | null {
  if (connectorType === 'github-issues') {
    // Prefer metadata.issueNumber if available
    if (metadata) {
      try {
        const meta: unknown = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
        if (
          typeof meta === 'object'
          && meta !== null
          && 'issueNumber' in meta
          && (typeof meta.issueNumber === 'string' || typeof meta.issueNumber === 'number')
        ) {
          return `#${meta.issueNumber}`;
        }
      } catch {
        // fall through to sourceId parsing
      }
    }
    // Fallback: parse from sourceId format "repo:number"
    if (sourceId) {
      const lastColon = sourceId.lastIndexOf(':');
      if (lastColon !== -1) {
        const num = sourceId.substring(lastColon + 1);
        if (/^\d+$/.test(num)) return `#${num}`;
      }
    }
  }

  // Future: add cases for other providers with meaningful IDs
  // e.g. Jira (PROJECT-123), Linear (LIN-42), etc.

  return null;
}
