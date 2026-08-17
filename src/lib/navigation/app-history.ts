'use client';

export const APP_HISTORY_STATE_KEY = '__missionControlHistory';
export const APP_HISTORY_DETAIL_STATE_KEY = '__missionControlDetail';
const APP_HISTORY_DETAIL_TRANSITION_KEY = '__missionControlDetailTransition';

export interface AppHistoryEntry {
  sessionId: string;
  position: number;
}

export interface AppHistoryDetailEntry {
  kind: 'detail';
  param: string;
  parentHref: string;
}

// History policy: push when entering addressable content, replace while
// changing that content, and keep transient controls out of browser history.

export interface AppHistorySnapshot {
  canGoBack: boolean;
  canGoForward: boolean;
  position: number;
  maxPosition: number;
}

type HistoryStateRecord = Record<string, unknown>;
type AppHistoryListener = () => void;

interface InstalledHistory {
  sessionId: string;
  position: number;
  maxPosition: number;
  snapshot: AppHistorySnapshot;
  originalPushState: History['pushState'];
  originalReplaceState: History['replaceState'];
  popstateHandler: () => void;
  referenceCount: number;
}

let installedHistory: InstalledHistory | null = null;
const appHistoryListeners = new Set<AppHistoryListener>();
const EMPTY_SNAPSHOT: AppHistorySnapshot = {
  canGoBack: false,
  canGoForward: false,
  position: 0,
  maxPosition: 0,
};

function asStateRecord(value: unknown): HistoryStateRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as HistoryStateRecord
    : {};
}

function createSessionId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function entryFor(state: unknown): AppHistoryEntry | null {
  const value = asStateRecord(state)[APP_HISTORY_STATE_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.sessionId === 'string'
    && Number.isInteger(candidate.position)
    && Number(candidate.position) >= 0
    ? {
        sessionId: candidate.sessionId,
        position: Number(candidate.position),
      }
    : null;
}

function stateWithEntry(
  state: unknown,
  sessionId: string,
  position: number,
): HistoryStateRecord {
  return {
    ...asStateRecord(state),
    [APP_HISTORY_STATE_KEY]: { sessionId, position },
  };
}

function emit() {
  const current = installedHistory;
  if (current) {
    current.snapshot = {
      canGoBack: current.position > 0,
      canGoForward: current.position < current.maxPosition,
      position: current.position,
      maxPosition: current.maxPosition,
    };
  }
  appHistoryListeners.forEach((listener) => listener());
}

export function getAppHistorySnapshot(): AppHistorySnapshot {
  return installedHistory?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribeToAppHistory(listener: AppHistoryListener): () => void {
  appHistoryListeners.add(listener);
  return () => appHistoryListeners.delete(listener);
}

export function installAppHistory(): () => void {
  if (installedHistory) {
    installedHistory.referenceCount += 1;
    return uninstallAppHistory;
  }

  const sessionId = createSessionId();
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);
  const current: InstalledHistory = {
    sessionId,
    position: 0,
    maxPosition: 0,
    snapshot: EMPTY_SNAPSHOT,
    originalPushState,
    originalReplaceState,
    popstateHandler: () => {},
    referenceCount: 1,
  };
  installedHistory = current;

  originalReplaceState(
    stateWithEntry(window.history.state, sessionId, 0),
    '',
  );

  window.history.pushState = function pushState(data, unused, url) {
    current.position += 1;
    current.maxPosition = current.position;
    const nextState = { ...asStateRecord(data) };
    if (nextState[APP_HISTORY_DETAIL_TRANSITION_KEY] === true) {
      delete nextState[APP_HISTORY_DETAIL_TRANSITION_KEY];
    } else {
      delete nextState[APP_HISTORY_DETAIL_STATE_KEY];
    }
    originalPushState(
      stateWithEntry(nextState, sessionId, current.position),
      unused,
      url,
    );
    emit();
  };

  window.history.replaceState = function replaceState(data, unused, url) {
    originalReplaceState(
      stateWithEntry(data, sessionId, current.position),
      unused,
      url,
    );
    emit();
  };

  current.popstateHandler = () => {
    const entry = entryFor(window.history.state);
    if (entry?.sessionId === sessionId) {
      current.position = entry.position;
    } else {
      current.position = 0;
      current.maxPosition = 0;
    }
    emit();
  };
  window.addEventListener('popstate', current.popstateHandler);
  emit();

  return uninstallAppHistory;
}

function uninstallAppHistory() {
  const current = installedHistory;
  if (!current) return;

  current.referenceCount -= 1;
  if (current.referenceCount > 0) return;

  window.history.pushState = current.originalPushState;
  window.history.replaceState = current.originalReplaceState;
  window.removeEventListener('popstate', current.popstateHandler);
  installedHistory = null;
}

export function appHistoryBack() {
  if (getAppHistorySnapshot().canGoBack) window.history.back();
}

export function appHistoryForward() {
  if (getAppHistorySnapshot().canGoForward) window.history.forward();
}

export function currentAppHistoryDetail(): AppHistoryDetailEntry | null {
  const value = asStateRecord(window.history.state)[APP_HISTORY_DETAIL_STATE_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'detail'
    && typeof candidate.param === 'string'
    && typeof candidate.parentHref === 'string'
    ? {
        kind: 'detail',
        param: candidate.param,
        parentHref: candidate.parentHref,
      }
    : null;
}

function stateWithDetail(detail: AppHistoryDetailEntry | null): HistoryStateRecord {
  const next = { ...asStateRecord(window.history.state) };
  if (detail) next[APP_HISTORY_DETAIL_STATE_KEY] = detail;
  else delete next[APP_HISTORY_DETAIL_STATE_KEY];
  return next;
}

export function pushAppHistoryDetail(url: string, detail: AppHistoryDetailEntry) {
  window.history.pushState({
    ...stateWithDetail(detail),
    [APP_HISTORY_DETAIL_TRANSITION_KEY]: true,
  }, '', url);
}

export function replaceAppHistoryDetail(
  url: string,
  detail: AppHistoryDetailEntry | null,
) {
  window.history.replaceState(stateWithDetail(detail), '', url);
}
