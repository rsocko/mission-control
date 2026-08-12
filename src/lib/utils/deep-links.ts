/**
 * Deep link URL generation for connector tasks.
 *
 * Each connector type that supports deep links provides a URL builder here.
 * The `deepLinks` capability on the connector gates whether the UI offers
 * "Open in <Source>" actions.
 */

/** Display metadata for a deep link */
export interface DeepLinkInfo {
  url: string;
  /** Human-readable source name, e.g. "GitHub" */
  label: string;
  /** Icon path for the connector */
  icon: string;
}

const CONNECTOR_DISPLAY: Record<string, { label: string; icon: string }> = {
  'github-issues': { label: 'GitHub', icon: '/icons/connectors/github.svg' },
};

/**
 * Build a deep link URL for a task given its connector type and sourceId.
 * Returns null if the connector type doesn't support deep links or the
 * sourceId can't be parsed into a valid URL.
 */
export function buildDeepLinkUrl(connectorType: string, sourceId: string): string | null {
  switch (connectorType) {
    case 'github-issues': {
      // sourceId format: "owner/repo:issueNumber"
      const lastColon = sourceId.lastIndexOf(':');
      if (lastColon === -1) return null;
      const repo = sourceId.substring(0, lastColon);
      const issueNumber = sourceId.substring(lastColon + 1);
      if (!repo || !issueNumber || isNaN(Number(issueNumber))) return null;
      return `https://github.com/${repo}/issues/${issueNumber}`;
    }
    default:
      return null;
  }
}

/**
 * Get full deep link info (URL + display metadata) for a task.
 * Returns null if the connector doesn't support deep links.
 */
export function getDeepLinkInfo(connectorType: string, sourceId: string): DeepLinkInfo | null {
  const display = CONNECTOR_DISPLAY[connectorType];
  if (!display) return null;

  const url = buildDeepLinkUrl(connectorType, sourceId);
  if (!url) return null;

  return { url, label: display.label, icon: display.icon };
}
