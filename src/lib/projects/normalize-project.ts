type ProjectJsonCollections = {
  sourceBindings: unknown;
  autoIncludeRules: unknown;
  kanbanColumns: unknown;
};

export function resolveProjectIconColor(
  iconColor: string | null | undefined,
  projectColor: string | null | undefined,
): string | undefined {
  return iconColor || projectColor || undefined;
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeProjectJsonCollections<T extends ProjectJsonCollections>(
  project: T,
): Omit<T, keyof ProjectJsonCollections> & {
  sourceBindings: unknown[];
  autoIncludeRules: unknown[];
  kanbanColumns: unknown[];
} {
  return {
    ...project,
    sourceBindings: normalizeJsonArray(project.sourceBindings),
    autoIncludeRules: normalizeJsonArray(project.autoIncludeRules),
    kanbanColumns: normalizeJsonArray(project.kanbanColumns),
  };
}
