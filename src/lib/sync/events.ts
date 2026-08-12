import { EventEmitter } from 'events';
import { syncLogger } from '@/lib/logger';

// ─── Sync Stream Event Types ────────────────────────────────────────────────

export interface SyncStartEvent {
  type: 'sync:start';
  connectorId: string;
  connectorName: string;
  phase: 'push' | 'lists' | 'tasks';
}

export interface SyncListsDiscoveredEvent {
  type: 'sync:lists-discovered';
  connectorId: string;
  listCount: number;
  lists: Array<{ id: string; name: string }>;
}

export interface SyncListProgressEvent {
  type: 'sync:list-progress';
  connectorId: string;
  listName: string;
  listIndex: number;
  totalLists: number;
  tasksInList: number;
}

export interface SyncTasksBatchEvent {
  type: 'sync:tasks-batch';
  connectorId: string;
  batchSize: number;
  totalSoFar: number;
  byStatus: { todo: number; done: number };
  /** Number of parent tasks (non-checklist items) synced so far */
  parentTasks: number;
  /** Number of checklist/sub-task items synced so far */
  subtasks: number;
}

export interface SyncCompleteEvent {
  type: 'sync:complete';
  connectorId: string;
  /** Number of syncs still queued or actively running after this one finished */
  queueRemaining: number;
  result: {
    tasksAdded: number;
    tasksUpdated: number;
    tasksRemoved: number;
    tasksPushed: number;
    localOnlyProtected: number;
    notificationsAdded: number;
    totalLists: number;
    durationMs: number;
    parentTasksAdded?: number;
    subtasksAdded?: number;
  };
}

export interface SyncErrorEvent {
  type: 'sync:error';
  connectorId: string;
  /** Number of syncs still queued or actively running after this one failed */
  queueRemaining: number;
  error: string;
  /** Sanitized build/release identity; absent on persisted events from older workers */
  runtimeRelease?: string;
}

export interface SyncDegradationEvent {
  type: 'sync:degradation';
  connectorId: string;
  durationMs: number;
  reason: string;
}

export type SyncStreamEvent =
  | SyncStartEvent
  | SyncListsDiscoveredEvent
  | SyncListProgressEvent
  | SyncTasksBatchEvent
  | SyncCompleteEvent
  | SyncErrorEvent
  | SyncDegradationEvent;

type SyncEventPersistence = (event: SyncStreamEvent) => void;
let persistSyncEvent: SyncEventPersistence | null = null;

export function setSyncEventPersistence(persistence: SyncEventPersistence | null): void {
  persistSyncEvent = persistence;
}

// ─── Singleton Event Emitter ────────────────────────────────────────────────

class SyncEventBus extends EventEmitter {
  emitSyncEvent(data: SyncStreamEvent): boolean {
    try {
      persistSyncEvent?.(data);
    } catch (error) {
      syncLogger.warn(
        { err: error, connectorId: data.connectorId, eventType: data.type },
        'Failed to persist sync progress event',
      );
    }
    return super.emit('sync-event', data);
  }

  onSyncEvent(listener: (data: SyncStreamEvent) => void): this {
    return super.on('sync-event', listener);
  }

  offSyncEvent(listener: (data: SyncStreamEvent) => void): this {
    return super.off('sync-event', listener);
  }
}

// Use globalThis to persist across hot reloads in dev
const globalKey = '__mc_sync_event_bus__';
const globalObj = globalThis as unknown as Record<string, SyncEventBus>;

export const syncEventBus: SyncEventBus = globalObj[globalKey] ?? new SyncEventBus();
globalObj[globalKey] = syncEventBus;

// Increase max listeners since multiple SSE clients may connect
syncEventBus.setMaxListeners(50);
