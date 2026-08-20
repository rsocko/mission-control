export const RECENT_PROJECT_IDS_STORAGE_KEY = 'mc:recent-project-ids';
export const MAX_RECENT_PROJECTS = 5;

export function parseRecentProjectIds(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const id = entry.trim();
      if (!id || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length === MAX_RECENT_PROJECTS) break;
    }
    return ids;
  } catch {
    return [];
  }
}

export function addRecentProjectId(ids: string[], projectId: string): string[] {
  const normalizedId = projectId.trim();
  if (!normalizedId) return ids.slice(0, MAX_RECENT_PROJECTS);

  return [
    normalizedId,
    ...ids.filter((id) => id !== normalizedId),
  ].slice(0, MAX_RECENT_PROJECTS);
}

export function getProjectIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/?#]+)/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
