export const LOCAL_TASK_SOURCE_TYPE = 'local';
export const LEGACY_LOCAL_TASK_SOURCE_TYPE = 'mission-control';

export function canonicalTaskSourceType(sourceType: string): string {
  return sourceType === LEGACY_LOCAL_TASK_SOURCE_TYPE
    ? LOCAL_TASK_SOURCE_TYPE
    : sourceType;
}

export function taskSourceTypesForFilter(sourceType: string): string[] {
  return canonicalTaskSourceType(sourceType) === LOCAL_TASK_SOURCE_TYPE
    ? [LOCAL_TASK_SOURCE_TYPE, LEGACY_LOCAL_TASK_SOURCE_TYPE]
    : [sourceType];
}
