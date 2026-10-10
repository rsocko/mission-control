export const LOCAL_TASK_SOURCE_TYPE = 'local';
export const LEGACY_LOCAL_TASK_SOURCE_TYPE = 'mission-control';
export const TYRION_FINANCE_TASK_SOURCE_TYPE = 'finance-manager';
export const TYRION_FINANCE_TASK_SOURCE_LIST_ID = 'tyrion-finance';
export const TYRION_FINANCE_TASK_SOURCE_LABEL = 'Tyrion';

export interface TaskSourceFilterIdentity {
  connectorTypes: string[];
  includedMissionControlSourceListIds: string[];
  excludedMissionControlSourceListIds: string[];
}

export function canonicalTaskSourceType(
  sourceType: string,
  sourceListId?: string | null,
): string {
  if (
    sourceType === LEGACY_LOCAL_TASK_SOURCE_TYPE
    && sourceListId === TYRION_FINANCE_TASK_SOURCE_LIST_ID
  ) {
    return TYRION_FINANCE_TASK_SOURCE_TYPE;
  }
  return sourceType === LEGACY_LOCAL_TASK_SOURCE_TYPE
    ? LOCAL_TASK_SOURCE_TYPE
    : sourceType;
}

export function taskSourceTypesForFilter(sourceType: string): string[] {
  return canonicalTaskSourceType(sourceType) === LOCAL_TASK_SOURCE_TYPE
    ? [LOCAL_TASK_SOURCE_TYPE, LEGACY_LOCAL_TASK_SOURCE_TYPE]
    : [sourceType];
}

export function taskSourceFilterIdentity(sourceType: string): TaskSourceFilterIdentity {
  const canonicalSourceType = canonicalTaskSourceType(sourceType);
  if (canonicalSourceType === LOCAL_TASK_SOURCE_TYPE) {
    return {
      connectorTypes: [LOCAL_TASK_SOURCE_TYPE, LEGACY_LOCAL_TASK_SOURCE_TYPE],
      includedMissionControlSourceListIds: [],
      excludedMissionControlSourceListIds: [TYRION_FINANCE_TASK_SOURCE_LIST_ID],
    };
  }
  if (canonicalSourceType === TYRION_FINANCE_TASK_SOURCE_TYPE) {
    return {
      connectorTypes: [TYRION_FINANCE_TASK_SOURCE_TYPE],
      includedMissionControlSourceListIds: [TYRION_FINANCE_TASK_SOURCE_LIST_ID],
      excludedMissionControlSourceListIds: [],
    };
  }
  return {
    connectorTypes: [canonicalSourceType],
    includedMissionControlSourceListIds: [],
    excludedMissionControlSourceListIds: [],
  };
}

interface TaskSourceOption {
  type: string;
  name: string;
  icon: string;
  notificationOnly?: boolean;
}

export function withTaskDerivedSourceOptions(
  sources: TaskSourceOption[],
  sourceCounts: Record<string, number>,
): TaskSourceOption[] {
  if ((sourceCounts[TYRION_FINANCE_TASK_SOURCE_TYPE] ?? 0) <= 0) return sources;

  const existing = sources.find((source) => source.type === TYRION_FINANCE_TASK_SOURCE_TYPE);
  if (existing) {
    return sources.map((source) => source === existing
      ? {
          ...source,
          name: TYRION_FINANCE_TASK_SOURCE_LABEL,
          notificationOnly: false,
        }
      : source);
  }

  const localIndex = sources.findIndex((source) => source.type === LOCAL_TASK_SOURCE_TYPE);
  const tyrion = {
    type: TYRION_FINANCE_TASK_SOURCE_TYPE,
    name: TYRION_FINANCE_TASK_SOURCE_LABEL,
    icon: 'finance',
    notificationOnly: false,
  };
  if (localIndex < 0) return [tyrion, ...sources];
  return [
    ...sources.slice(0, localIndex + 1),
    tyrion,
    ...sources.slice(localIndex + 1),
  ];
}
