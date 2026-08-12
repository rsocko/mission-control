interface RecurringTaskCandidate {
  id: string;
  sourceId: string;
  title: string;
  sourceListId: string | null;
  dueDate: string | null;
  updatedAt: string;
  metadata: unknown;
}

interface RecurringTaskHistoryCandidate {
  title: string;
  sourceListId: string | null;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
  metadata: unknown;
}

export interface RecurringTaskDuplicateGroup {
  keeper: RecurringTaskCandidate;
  duplicates: RecurringTaskCandidate[];
}

function parseMetadata(metadata: RecurringTaskCandidate['metadata']): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata !== 'string') {
    return typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : {};
  }

  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getRecurrenceIdentity(metadata: unknown): string | null {
  const recurrenceIdentity = parseMetadata(metadata).recurrenceIdentity;
  return typeof recurrenceIdentity === 'string' && recurrenceIdentity.length > 0
    ? recurrenceIdentity
    : null;
}

function getRecurrenceLabel(metadata: unknown): string | null {
  const recurrence = parseMetadata(metadata).recurrence;
  if (typeof recurrence !== 'string') return null;
  const normalized = recurrence.trim().toLowerCase();
  return normalized || null;
}

export function getRecurringSeriesKey(task: {
  title: string;
  sourceListId: string | null;
  metadata: unknown;
}): string | null {
  const recurrenceIdentity = getRecurrenceIdentity(task.metadata);
  const recurrencePattern = recurrenceIdentity ?? getRecurrenceLabel(task.metadata);
  if (!recurrencePattern) return null;
  return `${getRecurringTitleKey(task)}::${recurrencePattern}`;
}

export function getRecurringTitleKey(task: {
  title: string;
  sourceListId?: string | null;
}): string {
  return `${task.title.trim().toLowerCase()}::${task.sourceListId || ''}`;
}

export function hasRecurringIdentity(task: { metadata: unknown }): boolean {
  return getRecurrenceIdentity(task.metadata) !== null;
}

export function hasRecurrenceEvidence(task: { metadata: unknown }): boolean {
  return hasRecurringIdentity(task) || getRecurrenceLabel(task.metadata) !== null;
}

export function shouldSuppressNonRecurringDuplicate(
  task: {
    title: string;
    sourceListId?: string | null;
    metadata: unknown;
  },
  openRecurringTitleKeys: ReadonlySet<string>,
): boolean {
  return !hasRecurrenceEvidence(task)
    && openRecurringTitleKeys.has(getRecurringTitleKey(task));
}

export function inferRecurringTitleKeys(
  tasks: RecurringTaskHistoryCandidate[],
): Set<string> {
  const groups = new Map<string, RecurringTaskHistoryCandidate[]>();
  for (const task of tasks) {
    const key = getRecurringTitleKey(task);
    const group = groups.get(key);
    if (group) group.push(task);
    else groups.set(key, [task]);
  }

  const recurringTitleKeys = new Set<string>();
  for (const [key, group] of groups) {
    if (group.some(hasRecurrenceEvidence)) {
      recurringTitleKeys.add(key);
      continue;
    }

    const completedDueDates = new Set(
      group.flatMap(task => (
        task.status === 'done' && task.completedAt && task.dueDate
          ? [task.dueDate.slice(0, 10)]
          : []
      )),
    );
    if (completedDueDates.size >= 3) recurringTitleKeys.add(key);
  }

  return recurringTitleKeys;
}

export function compareRecurringOccurrencePriority(
  a: Pick<RecurringTaskCandidate, 'dueDate' | 'updatedAt'>,
  b: Pick<RecurringTaskCandidate, 'dueDate' | 'updatedAt'>,
  today: string,
): number {
  const aUpcoming = !!a.dueDate && a.dueDate >= today;
  const bUpcoming = !!b.dueDate && b.dueDate >= today;

  if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
  if (aUpcoming && bUpcoming) {
    const dueComparison = a.dueDate!.localeCompare(b.dueDate!);
    if (dueComparison !== 0) return dueComparison;
  }

  if (a.dueDate && b.dueDate) {
    const dueComparison = b.dueDate.localeCompare(a.dueDate);
    if (dueComparison !== 0) return dueComparison;
  } else if (a.dueDate !== b.dueDate) {
    return a.dueDate ? -1 : 1;
  }

  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * Microsoft To Do gives each recurrence occurrence a new task ID. Reconcile
 * duplicate active rows while avoiding groups that contain distinct recurrence
 * patterns with the same title. Microsoft sometimes omits recurrence metadata
 * from one copy, so a single known series also owns exact-title siblings.
 */
export function findOpenRecurringTaskDuplicates(
  tasks: RecurringTaskCandidate[],
  today: string,
  knownRecurringTitleKeys: ReadonlySet<string> = new Set(),
): RecurringTaskDuplicateGroup[] {
  const groups = new Map<string, RecurringTaskCandidate[]>();

  for (const task of tasks) {
    const key = getRecurringTitleKey(task);
    const group = groups.get(key);
    if (group) group.push(task);
    else groups.set(key, [task]);
  }

  const duplicateGroups: RecurringTaskDuplicateGroup[] = [];
  for (const [key, group] of groups) {
    if (group.length <= 1) continue;

    const identityTasks = group.filter(hasRecurringIdentity);
    const recurrenceTasks = group.filter(hasRecurrenceEvidence);
    const recurrenceIdentities = new Set(
      identityTasks.flatMap(task => getRecurrenceIdentity(task.metadata) ?? []),
    );
    const recurrenceLabels = new Set(
      recurrenceTasks.flatMap(task => getRecurrenceLabel(task.metadata) ?? []),
    );

    if (recurrenceIdentities.size > 1) continue;
    if (recurrenceIdentities.size === 0 && recurrenceLabels.size > 1) continue;
    if (
      recurrenceIdentities.size === 0
      && recurrenceLabels.size === 0
      && !knownRecurringTitleKeys.has(key)
    ) continue;

    const keeperCandidates = identityTasks.length > 0
      ? identityTasks
      : recurrenceTasks.length > 0
        ? recurrenceTasks
        : group;
    const recurringByPriority = [...keeperCandidates]
      .sort((a, b) => compareRecurringOccurrencePriority(a, b, today));
    const keeper = recurringByPriority[0];
    const duplicates = group
      .filter(task => task.id !== keeper.id)
      .sort((a, b) => compareRecurringOccurrencePriority(a, b, today));
    duplicateGroups.push({ keeper, duplicates });
  }

  return duplicateGroups;
}

export function shouldSuppressRecurringMyDaySuccessor(input: {
  isRecurring: boolean;
  dueDate?: string;
  today: string;
  successorCreatedAfterMyDayCompletion: boolean;
}): boolean {
  if (!input.isRecurring) return false;
  if (input.dueDate && input.dueDate > input.today) return true;
  return input.successorCreatedAfterMyDayCompletion;
}

export function isMatchingRecurringSuccessor(input: {
  incomingRecurrence: string | null;
  completedSiblingMetadata: unknown;
  successorCreatedAt: string;
  completedAt: string | null;
}): boolean {
  if (!input.incomingRecurrence || !input.completedAt) return false;
  const completedRecurrence = parseMetadata(input.completedSiblingMetadata).recurrence;
  if (completedRecurrence !== input.incomingRecurrence) return false;

  const successorCreatedAt = new Date(input.successorCreatedAt).getTime();
  const completedAt = new Date(input.completedAt).getTime();
  return Number.isFinite(successorCreatedAt)
    && Number.isFinite(completedAt)
    && successorCreatedAt >= completedAt;
}
