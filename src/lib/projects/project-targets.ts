import {
  addRecentProjectId,
  parseRecentProjectIds,
} from '@/lib/navigation/recent-projects';

export const RECENT_PROJECT_TARGETS_STORAGE_KEY = 'mission-control:recent-project-targets';

interface ProjectTarget {
  id: string;
  category?: string | null;
}

export interface ProjectTargetCategory<T extends ProjectTarget> {
  category: string;
  projects: T[];
}

export function getRecentProjectTargetIds(): string[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    return parseRecentProjectIds(localStorage.getItem(RECENT_PROJECT_TARGETS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveRecentProjectTarget(projectId: string): void {
  if (typeof localStorage === 'undefined') return;

  try {
    const recentIds = addRecentProjectId(getRecentProjectTargetIds(), projectId);
    localStorage.setItem(RECENT_PROJECT_TARGETS_STORAGE_KEY, JSON.stringify(recentIds));
  } catch {
    // Project assignment still works when browser storage is unavailable.
  }
}

export function groupProjectTargets<T extends ProjectTarget>(
  projects: T[],
  recentIds = getRecentProjectTargetIds(),
): {
  recentProjects: T[];
  categories: ProjectTargetCategory<T>[];
} {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const recentProjects = recentIds
    .map((id) => projectsById.get(id))
    .filter((project): project is T => project !== undefined);
  const recentProjectIds = new Set(recentProjects.map((project) => project.id));
  const grouped = new Map<string, T[]>();

  for (const project of projects) {
    if (recentProjectIds.has(project.id)) continue;
    const category = project.category || '';
    grouped.set(category, [...(grouped.get(category) ?? []), project]);
  }

  const categoryNames = [...grouped.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  return {
    recentProjects,
    categories: categoryNames.map((category) => ({
      category,
      projects: grouped.get(category) ?? [],
    })),
  };
}
