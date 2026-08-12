import { parseFilterQuery } from './parseFilterQuery';

interface KeywordFilterTask {
  title: string;
  status: string;
  localDisposition?: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  connectorInstanceId?: string | null;
  sourceListId?: string | null;
  sourceListName?: string | null;
  assignee?: string | null;
  tags?: Array<{ name: string; slug: string }>;
  projectPhaseMemberships?: Array<{
    projectId: string;
    phaseId: string | null;
  }>;
  metadata?: string | null;
}

/**
 * Client-side keyword filter for tasks.
 *
 * Supports structured filter tokens (title:X, tag:Y, priority:high, …) as well
 * as plain free-text terms. Values within one category are ORed, while
 * categories and free-text terms are ANDed together.
 *
 * Searches the full task array (not just visible/virtualized items).
 */
export function filterTasksByKeyword<T extends KeywordFilterTask>(tasks: T[], keyword: string): T[] {
  if (!keyword.trim()) return tasks;

  const parsed = parseFilterQuery(keyword);

  return tasks.filter((task) => {
    // ── Structured token checks ──────────────────────────────────────────────

    if (!matchesAny(parsed.titleTokens, (v) => task.title.toLowerCase().includes(v))) return false;

    if (!matchesAny(parsed.tagTokens, (v) => matchesTag(task, v))) return false;

    if (!matchesAny(parsed.priorityTokens, (v) => matchesPriority(task, v))) return false;

    if (!matchesAny(parsed.statusTokens, (v) => task.status.toLowerCase() === v)) return false;

    if (!matchesAny(parsed.sourceTokens, (v) => task.connectorType.toLowerCase() === v)) return false;

    if (!matchesAny(parsed.listTokens, (v) => matchesList(task, v))) return false;
    if (!matchesAny(parsed.listIdTokens, (v) => taskListIdentity(task) === v)) return false;

    if (!matchesAny(parsed.assigneeTokens, (v) => matchesAssignee(task, v))) return false;
    if (!matchesAny(parsed.dueTokens, (v) => matchesDueDate(task.dueDate, v))) return false;
    if (!matchesAny(parsed.projectTokens, (v) => matchesProject(task, v))) return false;
    if (!matchesAny(parsed.phaseTokens, (v) => matchesPhase(task, v))) return false;
    if (!matchesAny(
      parsed.dispositionTokens,
      (v) => task.localDisposition?.toLowerCase() === v,
    )) return false;

    for (const token of parsed.negatedTokens) {
      if (matchesToken(task, token.type, token.value)) return false;
    }

    // ── Free-text terms: match against title, tags, list name, assignee, metadata
    if (parsed.textTerms.length > 0) {
      const searchableText = buildSearchableText(task);
      for (const term of parsed.textTerms) {
        if (!searchableText.includes(term)) return false;
      }

    }

    return true;
  });
}

function matchesAny(values: string[], predicate: (value: string) => boolean): boolean {
  return values.length === 0 || values.some(predicate);
}

function matchesToken(task: KeywordFilterTask, type: string, value: string): boolean {
  switch (type) {
    case 'title':
      return task.title.toLowerCase().includes(value);
    case 'tag':
      return matchesTag(task, value);
    case 'priority':
      return matchesPriority(task, value);
    case 'listid':
      return taskListIdentity(task) === value;
    case 'status':
      return task.status.toLowerCase() === value;
    case 'source':
      return task.connectorType.toLowerCase() === value;
    case 'list':
      return matchesList(task, value);
    case 'assignee':
      return matchesAssignee(task, value);
    case 'due':
      return matchesDueDate(task.dueDate, value);
    case 'project':
      return matchesProject(task, value);
    case 'phase':
      return matchesPhase(task, value);
    case 'disposition':
      return task.localDisposition?.toLowerCase() === value;
    default:
      return false;
  }
}

const PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

function matchesPriority(task: KeywordFilterTask, value: string): boolean {
  const match = /^(>=|<=|>|<)?(critical|high|medium|low|none)$/.exec(value);
  if (!match) return false;

  const operator = match[1] || '=';
  const selectedIndex = PRIORITIES.indexOf(match[2] as typeof PRIORITIES[number]);
  const taskIndex = PRIORITIES.indexOf(
    task.priority.toLowerCase() as typeof PRIORITIES[number],
  );
  if (taskIndex < 0) return false;

  if (operator === '>=') return taskIndex <= selectedIndex;
  if (operator === '>') return taskIndex < selectedIndex;
  if (operator === '<=') return taskIndex >= selectedIndex;
  if (operator === '<') return taskIndex > selectedIndex;
  return taskIndex === selectedIndex;
}

function matchesTag(task: KeywordFilterTask, value: string): boolean {
  if (value === 'none') return !task.tags?.length;
  return Boolean(task.tags?.some(
    (tag) => tag.slug.toLowerCase() === value || tag.name.toLowerCase() === value,
  ));
}

function matchesList(task: KeywordFilterTask, value: string): boolean {
  if (value === 'none') {
    return !task.sourceListId?.trim() && !task.sourceListName?.trim();
  }
  return Boolean(task.sourceListName?.toLowerCase().includes(value));
}

function matchesAssignee(task: KeywordFilterTask, value: string): boolean {
  if (value === 'none') return !task.assignee?.trim();
  return Boolean(task.assignee?.toLowerCase().includes(value));
}

function matchesProject(task: KeywordFilterTask, value: string): boolean {
  if (value === 'none') return !task.projectPhaseMemberships?.length;
  return Boolean(task.projectPhaseMemberships?.some(
    (membership) => membership.projectId === value,
  ));
}

function matchesPhase(task: KeywordFilterTask, value: string): boolean {
  if (value === 'none') {
    return !task.projectPhaseMemberships?.some((membership) => membership.phaseId);
  }
  return Boolean(task.projectPhaseMemberships?.some(
    (membership) => membership.phaseId === value,
  ));
}

function taskListIdentity(task: KeywordFilterTask): string {
  if (!task.sourceListId) return '';
  return task.connectorInstanceId
    ? `${task.connectorInstanceId}:${task.sourceListId}`
    : task.sourceListId;
}

function matchesDueDate(dueDate: string | null, value: string): boolean {
  const today = new Date();
  const todayString = toLocalDateString(today);

  if (value === 'none') return dueDate === null;
  if (dueDate === null) return false;
  if (value === 'overdue') return dueDate < todayString;
  if (value === 'today') return dueDate === todayString;
  if (value === 'week') {
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);
    return dueDate >= todayString && dueDate <= toLocalDateString(weekEnd);
  }
  if (value.startsWith('<')) return dueDate < value.slice(1);
  if (value.startsWith('>')) return dueDate > value.slice(1);
  return dueDate === value;
}

function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildSearchableText(task: KeywordFilterTask): string {
  const parts: string[] = [task.title.toLowerCase()];

  if (task.tags?.length) {
    for (const tag of task.tags) {
      parts.push(tag.name.toLowerCase());
      parts.push(tag.slug.toLowerCase());
    }
  }

  if (task.sourceListName) {
    parts.push(task.sourceListName.toLowerCase());
  }

  if (task.assignee) {
    parts.push(task.assignee.toLowerCase());
  }

  // Include metadata as searchable text (limited to avoid perf issues with large blobs)
  if (task.metadata) {
    try {
      const metaStr = typeof task.metadata === 'string' ? task.metadata : JSON.stringify(task.metadata);
      // Only include first 500 chars of metadata to avoid perf problems
      parts.push(metaStr.substring(0, 500).toLowerCase());
    } catch {
      // Ignore parse errors
    }
  }

  return parts.join(' ');
}
