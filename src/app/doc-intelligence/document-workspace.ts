export interface DocumentTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  connectorInstanceId: string;
  sourceId: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: string | null;
}

export interface DocumentTaskMetadata {
  actionType?: string;
  urgency?: string;
  amount?: number;
  correspondent?: string;
  documentTitle?: string;
  documentType?: string;
  previewUrl?: string;
}

export type DocumentView =
  | 'all'
  | 'payments'
  | 'review-sign'
  | 'responses'
  | 'filing'
  | 'due-soon'
  | 'overdue';

export type DocumentSort = 'priority' | 'dueDate' | 'amount' | 'correspondent' | 'createdAt';
export type DocumentGroup = 'none' | 'actionType' | 'urgency' | 'correspondent' | 'dueDate';
export type SortDirection = 'asc' | 'desc';

export interface DocumentFilters {
  view: DocumentView;
  actionType: string;
  urgency: string;
  correspondent: string;
  query: string;
}

export interface DocumentTaskGroup {
  id: string;
  label: string | null;
  tasks: DocumentTask[];
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const VIEW_ACTION_TYPES: Partial<Record<DocumentView, ReadonlySet<string>>> = {
  payments: new Set(['pay']),
  'review-sign': new Set(['review', 'sign']),
  responses: new Set(['respond', 'schedule']),
  filing: new Set(['file']),
};

export function parseDocumentTaskMetadata(metadata: string | null | undefined): DocumentTaskMetadata {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!parsed || typeof parsed !== 'object') return {};
    const value = parsed as Record<string, unknown>;
    return {
      actionType: typeof value.actionType === 'string' ? value.actionType : undefined,
      urgency: typeof value.urgency === 'string' ? value.urgency : undefined,
      amount: typeof value.amount === 'number' && Number.isFinite(value.amount) ? value.amount : undefined,
      correspondent: typeof value.correspondent === 'string' ? value.correspondent : undefined,
      documentTitle: typeof value.documentTitle === 'string' ? value.documentTitle : undefined,
      documentType: typeof value.documentType === 'string' ? value.documentType : undefined,
      previewUrl: typeof value.previewUrl === 'string' ? value.previewUrl : undefined,
    };
  } catch {
    return {};
  }
}

function localDateTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`).getTime()
    : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dueDateBucket(task: DocumentTask, now = new Date()): 'overdue' | 'today' | 'upcoming' | 'no-date' {
  const dueAt = localDateTimestamp(task.dueDate);
  if (dueAt === null) return 'no-date';
  const today = startOfLocalDay(now);
  const dueDay = startOfLocalDay(new Date(dueAt));
  if (dueDay < today) return 'overdue';
  if (dueDay === today) return 'today';
  return 'upcoming';
}

function matchesView(task: DocumentTask, view: DocumentView, now: Date): boolean {
  const allowedActionTypes = VIEW_ACTION_TYPES[view];
  const metadata = parseDocumentTaskMetadata(task.metadata);
  if (allowedActionTypes) return allowedActionTypes.has(metadata.actionType ?? '');
  if (view === 'overdue') return dueDateBucket(task, now) === 'overdue';
  if (view === 'due-soon') {
    const dueAt = localDateTimestamp(task.dueDate);
    if (dueAt === null) return false;
    const today = startOfLocalDay(now);
    const dueDay = startOfLocalDay(new Date(dueAt));
    return dueDay >= today && dueDay <= today + (7 * 24 * 60 * 60 * 1000);
  }
  return true;
}

export function filterDocumentTasks(
  tasks: DocumentTask[],
  filters: DocumentFilters,
  now = new Date(),
): DocumentTask[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    const metadata = parseDocumentTaskMetadata(task.metadata);
    if (!matchesView(task, filters.view, now)) return false;
    if (filters.actionType !== 'all' && metadata.actionType !== filters.actionType) return false;
    if (filters.urgency !== 'all' && metadata.urgency !== filters.urgency) return false;
    if (filters.correspondent !== 'all' && metadata.correspondent !== filters.correspondent) return false;
    if (!query) return true;
    return [
      task.title,
      task.description,
      metadata.correspondent,
      metadata.documentTitle,
      metadata.documentType,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  });
}

function compareNullable<T>(
  left: T | null | undefined,
  right: T | null | undefined,
  compare: (a: T, b: T) => number,
  direction: SortDirection,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return compare(left, right) * (direction === 'asc' ? 1 : -1);
}

export function sortDocumentTasks(
  tasks: DocumentTask[],
  sortBy: DocumentSort,
  direction: SortDirection,
): DocumentTask[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...tasks].sort((left, right) => {
    const leftMetadata = parseDocumentTaskMetadata(left.metadata);
    const rightMetadata = parseDocumentTaskMetadata(right.metadata);
    let comparison = 0;
    if (sortBy === 'priority') {
      comparison = (PRIORITY_ORDER[leftMetadata.urgency ?? left.priority] ?? 5)
        - (PRIORITY_ORDER[rightMetadata.urgency ?? right.priority] ?? 5);
    } else if (sortBy === 'dueDate') {
      comparison = compareNullable(
        localDateTimestamp(left.dueDate),
        localDateTimestamp(right.dueDate),
        (a, b) => a - b,
        direction,
      );
    } else if (sortBy === 'amount') {
      comparison = compareNullable(leftMetadata.amount, rightMetadata.amount, (a, b) => a - b, direction);
    } else if (sortBy === 'correspondent') {
      comparison = compareNullable(
        leftMetadata.correspondent,
        rightMetadata.correspondent,
        (a, b) => a.localeCompare(b),
        direction,
      );
    } else {
      comparison = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    }
    const directedComparison = sortBy === 'priority' || sortBy === 'createdAt'
      ? comparison * multiplier
      : comparison;
    return directedComparison || left.title.localeCompare(right.title);
  });
}

function groupValue(task: DocumentTask, groupBy: Exclude<DocumentGroup, 'none'>): { id: string; label: string } {
  const metadata = parseDocumentTaskMetadata(task.metadata);
  if (groupBy === 'actionType') {
    const value = metadata.actionType || 'other';
    return { id: value, label: titleCase(value) };
  }
  if (groupBy === 'urgency') {
    const value = metadata.urgency || 'none';
    return { id: value, label: titleCase(value) };
  }
  if (groupBy === 'correspondent') {
    const value = metadata.correspondent || 'Unknown correspondent';
    return { id: value, label: value };
  }
  const bucket = dueDateBucket(task);
  const labels = {
    overdue: 'Overdue',
    today: 'Due today',
    upcoming: 'Upcoming',
    'no-date': 'No due date',
  };
  return { id: bucket, label: labels[bucket] };
}

export function groupDocumentTasks(tasks: DocumentTask[], groupBy: DocumentGroup): DocumentTaskGroup[] {
  if (groupBy === 'none') return [{ id: 'all', label: null, tasks }];
  const groups = new Map<string, DocumentTaskGroup>();
  for (const task of tasks) {
    const value = groupValue(task, groupBy);
    const group = groups.get(value.id) ?? { id: value.id, label: value.label, tasks: [] };
    group.tasks.push(task);
    groups.set(value.id, group);
  }
  return Array.from(groups.values());
}

export function countByMetadata(
  tasks: DocumentTask[],
  key: 'actionType' | 'urgency' | 'correspondent',
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const value = parseDocumentTaskMetadata(task.metadata)[key];
    if (typeof value === 'string' && value) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function countDocumentViews(tasks: DocumentTask[], now = new Date()): Record<DocumentView, number> {
  const views: DocumentView[] = ['all', 'payments', 'review-sign', 'responses', 'filing', 'due-soon', 'overdue'];
  return Object.fromEntries(
    views.map((view) => [view, tasks.filter((task) => matchesView(task, view, now)).length]),
  ) as Record<DocumentView, number>;
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
