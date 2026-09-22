/**
 * Deep link URL generation for connector tasks.
 *
 * Each connector type that supports deep links provides a URL builder here.
 * The `deepLinks` capability on the connector gates whether the UI offers
 * "Open in <Source>" actions.
 */

/** Display metadata for a source link shown in task details. */
export interface SourceLinkInfo {
  url: string;
  /** Human-readable source name, e.g. "GitHub" */
  label: string;
  /** Icon path for the connector */
  icon?: string;
}

/** Connector deep links always have a registered connector icon. */
export interface DeepLinkInfo extends SourceLinkInfo {
  icon: string;
}

const CONNECTOR_DISPLAY: Record<string, { label: string; icon: string }> = {
  'github-issues': { label: 'GitHub', icon: '/icons/connectors/github.svg' },
};

const LINKED_RESOURCE_ICONS: Array<{
  matches: (applicationName: string) => boolean;
  label: string;
  icon: string;
}> = [
  {
    matches: applicationName => /\boutlook\b/i.test(applicationName),
    label: 'Outlook',
    icon: '/icons/connectors/outlook.svg',
  },
];

function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a task's first usable external linked resource.
 * Mission Control links are omitted because they only point back to the current app.
 */
export function getLinkedResourceDeepLinkInfo(linkedResources: unknown): SourceLinkInfo | null {
  if (!Array.isArray(linkedResources)) return null;

  for (const resource of linkedResources) {
    if (!resource || typeof resource !== 'object') continue;
    const candidate = resource as Record<string, unknown>;
    const applicationName = typeof candidate.applicationName === 'string'
      ? candidate.applicationName.trim()
      : '';
    if (/^mission control$/i.test(applicationName)) continue;

    const url = safeWebUrl(candidate.webUrl);
    if (!url) continue;

    const knownDisplay = LINKED_RESOURCE_ICONS.find(display => display.matches(applicationName));
    if (knownDisplay) {
      return { url, label: knownDisplay.label, icon: knownDisplay.icon };
    }

    const displayName = typeof candidate.displayName === 'string'
      ? candidate.displayName.trim()
      : '';
    return {
      url,
      label: applicationName || displayName || 'source',
    };
  }

  return null;
}

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
