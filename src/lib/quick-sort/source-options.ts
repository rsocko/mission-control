import { canonicalTaskSourceType, LOCAL_TASK_SOURCE_TYPE } from '@/lib/tasks/source-hierarchy';
import type { SourceList } from '@/types/dashboard';

export interface QuickSortSourceRow {
  connectorType: string;
  connectorInstanceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  count: number;
}

export interface QuickSortSourceListDefinition {
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  userDisplayName: string | null;
  type: string;
  icon: string | null;
  iconColor: string | null;
  hidden: boolean;
}

export interface QuickSortSourceListOption extends Pick<SourceList, 'type' | 'icon' | 'iconColor'> {
  connectorId: string;
  sourceListId: string | null;
  name: string;
  count: number;
}

export interface QuickSortSourceOption {
  connectorId: string;
  count: number;
  lists: QuickSortSourceListOption[];
}

export type QuickSortSourceData = Record<string, QuickSortSourceOption>;

function definitionKey(connectorInstanceId: string, sourceListId: string): string {
  return JSON.stringify([connectorInstanceId, sourceListId]);
}

function normalizedDefinitionName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function addUniqueDefinition(
  index: Map<string, QuickSortSourceListDefinition | null>,
  key: string,
  definition: QuickSortSourceListDefinition,
) {
  if (!index.has(key)) {
    index.set(key, definition);
  } else if (index.get(key)?.sourceId !== definition.sourceId) {
    index.set(key, null);
  }
}

export function buildQuickSortSourceData(
  rows: QuickSortSourceRow[],
  definitions: QuickSortSourceListDefinition[],
): QuickSortSourceData {
  const definitionsById = new Map(
    definitions.map((definition) => [
      definitionKey(definition.connectorInstanceId, definition.sourceId),
      definition,
    ]),
  );
  const definitionsByName = new Map<string, QuickSortSourceListDefinition | null>();
  for (const definition of definitions) {
    const names = new Set([
      definition.name,
      definition.userDisplayName,
    ].filter((name): name is string => Boolean(name?.trim())));
    for (const name of names) {
      addUniqueDefinition(
        definitionsByName,
        definitionKey(definition.connectorInstanceId, normalizedDefinitionName(name)),
        definition,
      );
    }
  }
  const grouped = new Map<string, {
    connectorId: string;
    count: number;
    lists: Map<string, QuickSortSourceListOption>;
  }>();

  for (const row of rows) {
    const connectorType = canonicalTaskSourceType(row.connectorType);
    const source = grouped.get(connectorType) ?? {
      connectorId: row.connectorInstanceId,
      count: 0,
      lists: new Map<string, QuickSortSourceListOption>(),
    };
    source.count += Number(row.count);
    grouped.set(connectorType, source);

    // Local is a leaf source in the canonical left nav, even when legacy
    // Mission Control tasks carry a denormalized "Local" list name.
    if (connectorType === LOCAL_TASK_SOURCE_TYPE || !row.sourceListName) continue;

    const definition = (
      row.sourceListId
        ? definitionsById.get(definitionKey(row.connectorInstanceId, row.sourceListId))
        : undefined
    ) ?? definitionsByName.get(definitionKey(
      row.connectorInstanceId,
      normalizedDefinitionName(row.sourceListName),
    )) ?? undefined;
    if (definition?.hidden) continue;

    const name = definition?.userDisplayName || definition?.name || row.sourceListName;
    const sourceListId = definition?.sourceId ?? row.sourceListId;
    const listKey = definitionKey(
      row.connectorInstanceId,
      sourceListId ?? normalizedDefinitionName(row.sourceListName),
    );
    const existing = source.lists.get(listKey);
    source.lists.set(listKey, {
      connectorId: row.connectorInstanceId,
      sourceListId: definition?.sourceId ?? row.sourceListId,
      name,
      count: (existing?.count ?? 0) + Number(row.count),
      type: definition?.type ?? existing?.type ?? null,
      icon: definition?.icon ?? existing?.icon ?? null,
      iconColor: definition?.iconColor ?? existing?.iconColor ?? null,
    });
  }

  return Object.fromEntries(
    [...grouped].map(([connectorType, source]) => [
      connectorType,
      {
        connectorId: source.connectorId,
        count: source.count,
        lists: [...source.lists.values()],
      },
    ]),
  );
}
