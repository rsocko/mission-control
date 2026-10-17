import {
  normalizeTaskFilterContext,
  serializeTaskFilterContext,
  taskFilterContextFromSavedView,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import type { EnabledSource, SavedView, SourceList } from '@/types/dashboard';

export const PINNED_TASK_SHORTCUTS_STORAGE_KEY = 'mc:pinned-task-shortcuts';
export const RECENT_TASK_SHORTCUTS_STORAGE_KEY = 'mc:recent-task-shortcuts';
export const TASK_SHORTCUTS_CHANGED_EVENT = 'mc:task-shortcuts-changed';
export const TASK_SHORTCUT_PRESENTATION_PARAM = 'tp';
export const MAX_RECENT_TASK_SHORTCUTS = 5;

export interface TaskShortcutPresentation {
  sortBy: string;
  sortDirection: 'asc' | 'desc';
  groupBy: string;
  viewDensity: 'compact' | 'comfortable';
}

export interface TaskShortcut {
  id: string;
  kind: 'source' | 'list' | 'saved-view';
  label: string;
  detail: string;
  connectorType?: string;
  icon?: string;
  iconColor?: string;
  context: TaskFilterContext;
  presentation?: TaskShortcutPresentation;
}

export function taskShortcutFromSource(source: EnabledSource): TaskShortcut {
  return {
    id: `source:${source.type}`,
    kind: 'source',
    label: source.name,
    detail: 'Source',
    connectorType: source.type,
    context: normalizeTaskFilterContext({ sources: [source.type] }),
  };
}

export function taskShortcutFromList(
  source: EnabledSource,
  list: SourceList,
): TaskShortcut {
  return {
    id: `list:${list.connectorInstanceId}:${list.sourceId}`,
    kind: 'list',
    label: list.name,
    detail: source.name,
    connectorType: source.type,
    icon: list.icon ?? undefined,
    iconColor: list.iconColor ?? undefined,
    context: normalizeTaskFilterContext({
      sources: [source.type],
      listIds: [list.sourceId],
    }),
  };
}

export function taskShortcutFromSavedView(view: SavedView): TaskShortcut {
  return {
    id: `saved-view:${view.id}`,
    kind: 'saved-view',
    label: view.name,
    detail: 'Saved view',
    icon: view.icon,
    iconColor: view.iconColor,
    context: view.filterContext ?? taskFilterContextFromSavedView(view.filters),
    presentation: view.presentation,
  };
}

export function buildTaskShortcutHref(shortcut: TaskShortcut): string {
  const params = new URLSearchParams();
  params.set('tf', serializeTaskFilterContext(shortcut.context));
  if (shortcut.presentation) {
    params.set(TASK_SHORTCUT_PRESENTATION_PARAM, JSON.stringify(shortcut.presentation));
  }
  return `/all-tasks?${params.toString()}`;
}

export function readTaskShortcuts(value: string | null): TaskShortcut[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const shortcuts: TaskShortcut[] = [];
    for (const item of parsed) {
      const shortcut = normalizeTaskShortcut(item);
      if (!shortcut || shortcuts.some((entry) => entry.id === shortcut.id)) continue;
      shortcuts.push(shortcut);
    }
    return shortcuts;
  } catch {
    return [];
  }
}

export function readPinnedTaskShortcuts(): TaskShortcut[] {
  if (typeof window === 'undefined') return [];
  try {
    return readTaskShortcuts(localStorage.getItem(PINNED_TASK_SHORTCUTS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function readRecentTaskShortcuts(): TaskShortcut[] {
  if (typeof window === 'undefined') return [];
  try {
    return readTaskShortcuts(localStorage.getItem(RECENT_TASK_SHORTCUTS_STORAGE_KEY))
      .slice(0, MAX_RECENT_TASK_SHORTCUTS);
  } catch {
    return [];
  }
}

export function isTaskShortcutPinned(shortcutId: string): boolean {
  return readPinnedTaskShortcuts().some((shortcut) => shortcut.id === shortcutId);
}

export function togglePinnedTaskShortcut(shortcut: TaskShortcut): boolean {
  const pinned = readPinnedTaskShortcuts();
  const isPinned = pinned.some((entry) => entry.id === shortcut.id);
  writeTaskShortcuts(
    PINNED_TASK_SHORTCUTS_STORAGE_KEY,
    isPinned
      ? pinned.filter((entry) => entry.id !== shortcut.id)
      : [...pinned, shortcut],
  );
  notifyTaskShortcutsChanged();
  return !isPinned;
}

export function recordRecentTaskShortcut(shortcut: TaskShortcut): void {
  const recent = readRecentTaskShortcuts();
  writeTaskShortcuts(
    RECENT_TASK_SHORTCUTS_STORAGE_KEY,
    [shortcut, ...recent.filter((entry) => entry.id !== shortcut.id)]
      .slice(0, MAX_RECENT_TASK_SHORTCUTS),
  );
  notifyTaskShortcutsChanged();
}

export function updateStoredTaskShortcut(shortcut: TaskShortcut): void {
  let changed = false;
  for (const key of [
    PINNED_TASK_SHORTCUTS_STORAGE_KEY,
    RECENT_TASK_SHORTCUTS_STORAGE_KEY,
  ] as const) {
    const items = key === PINNED_TASK_SHORTCUTS_STORAGE_KEY
      ? readPinnedTaskShortcuts()
      : readRecentTaskShortcuts();
    if (!items.some((item) => item.id === shortcut.id)) continue;
    writeTaskShortcuts(
      key,
      items.map((item) => item.id === shortcut.id ? shortcut : item),
    );
    changed = true;
  }
  if (changed) notifyTaskShortcutsChanged();
}

export function removeStoredTaskShortcut(shortcutId: string): void {
  let changed = false;
  for (const key of [
    PINNED_TASK_SHORTCUTS_STORAGE_KEY,
    RECENT_TASK_SHORTCUTS_STORAGE_KEY,
  ] as const) {
    const items = key === PINNED_TASK_SHORTCUTS_STORAGE_KEY
      ? readPinnedTaskShortcuts()
      : readRecentTaskShortcuts();
    const next = items.filter((item) => item.id !== shortcutId);
    if (next.length === items.length) continue;
    writeTaskShortcuts(key, next);
    changed = true;
  }
  if (changed) notifyTaskShortcutsChanged();
}

export function parseTaskShortcutPresentation(
  value: string | null,
): TaskShortcutPresentation | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.sortBy !== 'string'
      || (candidate.sortDirection !== 'asc' && candidate.sortDirection !== 'desc')
      || typeof candidate.groupBy !== 'string'
      || (candidate.viewDensity !== 'compact' && candidate.viewDensity !== 'comfortable')
    ) {
      return null;
    }
    return {
      sortBy: candidate.sortBy,
      sortDirection: candidate.sortDirection,
      groupBy: candidate.groupBy,
      viewDensity: candidate.viewDensity,
    };
  } catch {
    return null;
  }
}

function writeTaskShortcuts(key: string, shortcuts: TaskShortcut[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(shortcuts));
  } catch {
    // Shortcuts remain available for the current interaction when storage is unavailable.
  }
}

function notifyTaskShortcutsChanged(): void {
  window.dispatchEvent(new CustomEvent(TASK_SHORTCUTS_CHANGED_EVENT));
}

function normalizeTaskShortcut(value: unknown): TaskShortcut | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string'
    || (item.kind !== 'source' && item.kind !== 'list' && item.kind !== 'saved-view')
    || typeof item.label !== 'string'
    || typeof item.detail !== 'string'
    || !item.context
    || typeof item.context !== 'object'
  ) {
    return null;
  }

  const presentation = normalizePresentation(item.presentation);
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    detail: item.detail,
    connectorType: typeof item.connectorType === 'string' ? item.connectorType : undefined,
    icon: typeof item.icon === 'string' ? item.icon : undefined,
    iconColor: typeof item.iconColor === 'string' ? item.iconColor : undefined,
    context: normalizeTaskFilterContext(item.context),
    presentation,
  };
}

function normalizePresentation(value: unknown): TaskShortcutPresentation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sortBy !== 'string'
    || (candidate.sortDirection !== 'asc' && candidate.sortDirection !== 'desc')
    || typeof candidate.groupBy !== 'string'
    || (candidate.viewDensity !== 'compact' && candidate.viewDensity !== 'comfortable')
  ) {
    return undefined;
  }
  return {
    sortBy: candidate.sortBy,
    sortDirection: candidate.sortDirection,
    groupBy: candidate.groupBy,
    viewDensity: candidate.viewDensity,
  };
}
