import type {
  TaskEditPolicy,
  TaskField,
  TaskFieldMutationMode,
  TaskSourceModel,
} from '@/types';

const TASK_FIELDS = [
  'title',
  'description',
  'status',
  'statusReason',
  'priority',
  'planningHorizon',
  'dueDate',
  'effort',
  'estimatedDuration',
  'recurrence',
  'reminderAt',
  'snoozedUntil',
  'microStatus',
  'tags',
  'projects',
  'phases',
  'dependencies',
  'kanbanPlacement',
  'localDisposition',
] as const satisfies readonly TaskField[];

const SOURCE_NATIVE_FIELDS = new Set<TaskField>([
  'title',
  'description',
  'status',
  'statusReason',
  'priority',
  'dueDate',
  'recurrence',
  'microStatus',
  'dependencies',
]);

interface TaskEditPolicyOptions {
  sourceModel?: TaskSourceModel;
  connectorEnabled?: boolean;
  mutations?: Partial<Record<TaskField, TaskFieldMutationMode>>;
  reasons?: Partial<Record<TaskField, string>>;
  removalMode?: TaskEditPolicy['removalMode'];
  removalReason?: string;
  sourceMoveSupported?: boolean;
}

export function makeTaskEditPolicy({
  sourceModel = 'mc-owned',
  connectorEnabled = true,
  mutations = {},
  reasons = {},
  removalMode = sourceModel === 'mc-owned'
    ? 'local-delete'
    : sourceModel === 'ingested'
      ? 'local-cancel'
      : sourceModel === 'remote-managed'
        ? 'upstream-delete'
        : 'local-dismiss',
  removalReason,
  sourceMoveSupported = sourceModel === 'mc-owned'
    || (sourceModel === 'remote-managed' && connectorEnabled),
}: TaskEditPolicyOptions = {}): TaskEditPolicy {
  const defaultMutation = (field: TaskField): TaskFieldMutationMode => {
    if (field === 'localDisposition') {
      return sourceModel === 'remote-mirror' ? 'local' : 'blocked';
    }
    if (sourceModel === 'mc-owned' || sourceModel === 'ingested') return 'local';
    if (SOURCE_NATIVE_FIELDS.has(field)) {
      return sourceModel === 'remote-managed' && connectorEnabled ? 'write-through' : 'blocked';
    }
    return 'local';
  };
  const fields = Object.fromEntries(TASK_FIELDS.map((field) => {
    const mutation = mutations[field] ?? defaultMutation(field);
    const reason = mutation === 'blocked'
      ? reasons[field] ?? (connectorEnabled
        ? `${field} is controlled by the upstream task source`
        : `${field} cannot be changed while its connector is disabled`)
      : undefined;
    return [field, {
      field,
      sourceModel,
      mutation,
      inbound: SOURCE_NATIVE_FIELDS.has(field) && sourceModel !== 'mc-owned'
        ? 'source-wins'
        : 'local-wins',
      ...(reason ? { reason } : {}),
    }];
  })) as TaskEditPolicy['fields'];
  const editableFields = TASK_FIELDS.filter((field) => fields[field].mutation !== 'blocked');
  const fieldReasons = Object.fromEntries(
    TASK_FIELDS.flatMap((field) => fields[field].reason ? [[field, fields[field].reason]] : []),
  ) as TaskEditPolicy['fieldReasons'];

  return {
    sourceModel,
    connectorEnabled,
    fields,
    editableFields,
    fieldReasons,
    localDeleteSupported: removalMode === 'local-delete',
    upstreamDeleteSupported: removalMode === 'upstream-delete',
    removalMode,
    ...(removalReason ? { removalReason } : {}),
    sourceMoveSupported,
    ...(!sourceMoveSupported ? { sourceMoveReason: 'This task cannot be moved within its source' } : {}),
    localDispositionSupported: fields.localDisposition.mutation !== 'blocked',
  };
}

export const editableTaskPolicy = makeTaskEditPolicy();
