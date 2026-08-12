import type {
  LocalDisposition,
  TaskEditPolicy,
  TaskField,
  TaskFieldMutationMode,
} from '@/types';

export const TASK_DISPOSITION_OPTIONS = [
  {
    value: 'active',
    label: 'Keep active',
    detail: 'Show this task in active Mission Control views.',
  },
  {
    value: 'handled',
    label: 'Mark handled here',
    detail: 'Hide it locally without completing the upstream task.',
  },
  {
    value: 'dismissed',
    label: 'Dismiss here',
    detail: 'Hide it locally without deleting the upstream task.',
  },
] as const satisfies ReadonlyArray<{
  value: LocalDisposition;
  label: string;
  detail: string;
}>;

export function taskFieldMutation(
  policy: TaskEditPolicy | null | undefined,
  field: TaskField,
): TaskFieldMutationMode {
  return policy?.fields?.[field]?.mutation ?? 'blocked';
}

export function canEditTaskField(
  policy: TaskEditPolicy | null | undefined,
  field: TaskField,
): boolean {
  return taskFieldMutation(policy, field) !== 'blocked';
}

export function taskFieldBlockedReason(
  policy: TaskEditPolicy | null | undefined,
  field: TaskField,
): string {
  return policy?.fieldReasons?.[field]
    ?? policy?.fields?.[field]?.reason
    ?? 'This field cannot be changed for this task source';
}

export function taskFieldSaveLabel(
  policy: TaskEditPolicy | null | undefined,
  field: TaskField,
): 'Saved in Mission Control' | 'Synced to source' {
  const mutation = taskFieldMutation(policy, field);
  return mutation === 'write-through' || mutation === 'pull-write-back'
    ? 'Synced to source'
    : 'Saved in Mission Control';
}

export function selectedTaskFieldBlockedReason(
  policies: readonly TaskEditPolicy[],
  field: TaskField,
): string | undefined {
  const blocked = policies.find((policy) => !canEditTaskField(policy, field));
  return blocked ? taskFieldBlockedReason(blocked, field) : undefined;
}

export function selectedTaskRemovalBlockedReason(
  policies: readonly TaskEditPolicy[],
): string | undefined {
  const blocked = policies.find((policy) => !canRemoveTask(policy));
  return blocked?.removalReason;
}

export function canSetTaskLocalDisposition(
  policy: TaskEditPolicy | null | undefined,
  current: LocalDisposition,
  target: LocalDisposition,
): boolean {
  if (target === 'active' && current !== 'active') return true;
  return canEditTaskField(policy, 'localDisposition');
}

export function taskDispositionBlockedReason(
  policy: TaskEditPolicy | null | undefined,
  current: LocalDisposition,
  target: LocalDisposition,
): string | undefined {
  return canSetTaskLocalDisposition(policy, current, target)
    ? undefined
    : taskFieldBlockedReason(policy, 'localDisposition');
}

export function selectedTaskDispositionBlockedReason(
  tasks: ReadonlyArray<{
    editPolicy: TaskEditPolicy;
    localDisposition: LocalDisposition;
  }>,
  target: LocalDisposition,
): string | undefined {
  const blocked = tasks.find((task) => !canSetTaskLocalDisposition(
    task.editPolicy,
    task.localDisposition,
    target,
  ));
  return blocked
    ? taskDispositionBlockedReason(blocked.editPolicy, blocked.localDisposition, target)
    : undefined;
}

export function canRemoveTask(policy: TaskEditPolicy | null | undefined): boolean {
  return Boolean(policy && policy.removalMode !== 'blocked');
}

export function taskRemovalLabel(policy: TaskEditPolicy | null | undefined): string {
  switch (policy?.removalMode) {
    case 'local-cancel':
      return 'Cancel task';
    case 'local-dismiss':
      return 'Dismiss here';
    case 'upstream-close':
      return 'Close at source';
    case 'upstream-delete':
      return 'Delete from source';
    case 'local-delete':
      return 'Delete task';
    default:
      return 'Remove task';
  }
}

export function taskRemovalConfirmation(
  policy: TaskEditPolicy,
  taskTitle: string,
): { title: string; message: string; confirmLabel: string } {
  switch (policy.removalMode) {
    case 'local-cancel':
      return {
        title: 'Cancel task?',
        message: `This will cancel "${taskTitle}" in Mission Control while preserving its source history.`,
        confirmLabel: 'Cancel task',
      };
    case 'local-dismiss':
      return {
        title: 'Dismiss task here?',
        message: `This will hide "${taskTitle}" in Mission Control without deleting or completing the upstream task.`,
        confirmLabel: 'Dismiss here',
      };
    case 'upstream-close':
      return {
        title: 'Close task at source?',
        message: `This will close "${taskTitle}" as not planned at its source.`,
        confirmLabel: 'Close task',
      };
    case 'upstream-delete':
      return {
        title: 'Delete task from source?',
        message: `This will delete "${taskTitle}" from its source.`,
        confirmLabel: 'Delete task',
      };
    case 'local-delete':
      return {
        title: 'Delete task?',
        message: `This will permanently delete "${taskTitle}" from Mission Control.`,
        confirmLabel: 'Delete task',
      };
    default:
      return {
        title: 'Remove task?',
        message: policy.removalReason ?? 'This task cannot be removed.',
        confirmLabel: 'Remove task',
      };
  }
}
