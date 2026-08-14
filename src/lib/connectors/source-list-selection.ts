export interface SourceListSelectionConnector {
  type: string;
  settings?: unknown;
  syncedLists?: unknown;
}

export interface SourceListSelectionCandidate {
  id: string;
  sourceId: string;
}

export function normalizeSyncedLists(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function getSettings(settings: unknown): Record<string, unknown> {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    return settings as Record<string, unknown>;
  }

  if (typeof settings === 'string') {
    try {
      const parsed = JSON.parse(settings);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  return {};
}

export function isSourceListSelected(
  connector: SourceListSelectionConnector,
  sourceList: SourceListSelectionCandidate,
): boolean {
  const settings = getSettings(connector.settings);
  const hasExplicitGitHubRepos = connector.type === 'github-issues'
    && Object.prototype.hasOwnProperty.call(settings, 'repos');
  const syncedLists = hasExplicitGitHubRepos
    ? normalizeSyncedLists(settings.repos)
    : normalizeSyncedLists(connector.syncedLists);

  return (!hasExplicitGitHubRepos && syncedLists.length === 0)
    || syncedLists.includes(sourceList.sourceId)
    || syncedLists.includes(sourceList.id);
}
