import { decodeLenientJsonArray } from '@/db/persistence/value-codecs';

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
  return decodeLenientJsonArray(value);
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
