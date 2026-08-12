/**
 * Offline Queue — captures + general-purpose mutation queue
 *
 * Uses IndexedDB to persist:
 *  1. Captured items (legacy PendingCapture) — synced via /api/tasks
 *  2. Generic offline actions (OfflineAction) — replayed by registered handlers
 *
 * Items are automatically synced to the server when connectivity returns.
 * Integrates with the service worker's Background Sync API when available.
 *
 * Refs: #1528
 */

import {
  OFFLINE_IMAGE_MAX_COUNT,
  OFFLINE_IMAGE_MAX_TOTAL_BYTES,
  type CaptureImageMimeType,
} from '@/lib/capture-image';

const DB_NAME = 'mission-control-offline';
const DB_VERSION = 2;
const STORE_NAME = 'pending-captures';
const ACTION_STORE = 'pending-actions';
export const SYNC_TAG = 'sync-offline-captures';
export const ACTION_SYNC_TAG = 'sync-offline-actions';

export interface PendingCapture {
  id: string;
  title: string;
  body?: string;
  createdAt: string;
  /** Number of sync attempts so far */
  attempts: number;
  /** Last error message if sync failed */
  lastError?: string;
  image?: PendingCaptureImage;
  destination?: PendingCaptureDestination;
}

export interface PendingCaptureDestination {
  connectorType: string;
  connectorInstanceId?: string;
  sourceListId?: string;
  sourceListName?: string;
}

export interface PendingCaptureImage {
  blob: Blob;
  name: string;
  type: CaptureImageMimeType;
  size: number;
}

export class OfflineImageQueueLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineImageQueueLimitError';
  }
}

/** Generic offline action that can represent any mutation */
export interface OfflineAction {
  id: string;
  /** Mutation type key (e.g. "task.complete", "task.updatePriority") */
  type: string;
  /** JSON-serializable payload with mutation data */
  payload: Record<string, unknown>;
  createdAt: string;
  /** Number of replay attempts so far */
  attempts: number;
  /** Last error message if replay failed */
  lastError?: string;
}

/** Input for queueing an offline action (id and metadata are generated) */
export interface QueueActionInput {
  type: string;
  payload: Record<string, unknown>;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      // v2: add generic action store
      if (!db.objectStoreNames.contains(ACTION_STORE)) {
        const store = db.createObjectStore(ACTION_STORE, { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Generate a simple unique ID for offline items */
function generateId(): string {
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Queue a capture for later sync */
export async function queueCapture(
  title: string,
  body?: string,
  image?: PendingCaptureImage,
  id = generateId(),
  destination?: PendingCaptureDestination,
): Promise<PendingCapture> {
  const item: PendingCapture = {
    id,
    title,
    body,
    createdAt: new Date().toISOString(),
    attempts: 0,
    image,
    destination,
  };

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const existingRequest = store.getAll();
    existingRequest.onsuccess = () => {
      if (image) {
        const queuedImages = (existingRequest.result as PendingCapture[])
          .flatMap((capture) => capture.image ? [capture.image] : []);
        const totalBytes = queuedImages.reduce((sum, queued) => sum + queued.size, 0);
        if (queuedImages.length >= OFFLINE_IMAGE_MAX_COUNT) {
          tx.abort();
          reject(new OfflineImageQueueLimitError(
            `Offline image queue is limited to ${OFFLINE_IMAGE_MAX_COUNT} images.`,
          ));
          return;
        }
        if (totalBytes + image.size > OFFLINE_IMAGE_MAX_TOTAL_BYTES) {
          tx.abort();
          reject(new OfflineImageQueueLimitError(
            `Offline image queue is limited to ${OFFLINE_IMAGE_MAX_TOTAL_BYTES} bytes.`,
          ));
          return;
        }
      }
      store.add(item);
    };
    existingRequest.onerror = () => reject(existingRequest.error);
    tx.oncomplete = () => {
      db.close();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('offline-queue:changed'));
      }
      resolve(item);
    };
    tx.onerror = () => {
      db.close();
      if (tx.error) reject(tx.error);
    };
    tx.onabort = () => db.close();
  });
}

/** Get all pending captures */
export async function getPendingCaptures(): Promise<PendingCapture[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/** Remove a successfully synced item */
export async function removePendingCapture(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Update an item (e.g., increment attempts or record error) */
export async function updatePendingCapture(item: PendingCapture): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Attempt to sync all pending captures to the server */
export async function syncPendingCaptures(): Promise<{ synced: number; failed: number }> {
  const items = await getPendingCaptures();
  let synced = 0;
  let failed = 0;

  for (const item of items) {
    try {
      let res: Response;
      if (item.image) {
        const form = new FormData();
        form.set('image', item.image.blob, item.image.name);
        form.set('title', item.title);
        if (item.body) form.set('description', item.body);
        form.set('client', 'browser');
        res = await fetch('/api/triage/capture/image', {
          method: 'POST',
          headers: { 'X-Idempotency-Key': item.id },
          body: form,
        });
      } else {
        res = await fetch('/api/tasks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': item.id,
          },
          body: JSON.stringify({
            title: item.title,
            description: item.body || undefined,
            status: 'todo',
            ...item.destination,
          }),
        });
      }

      if (res.ok) {
        await removePendingCapture(item.id);
        synced++;
      } else {
        item.attempts++;
        item.lastError = `HTTP ${res.status}`;
        await updatePendingCapture(item);
        failed++;
      }
    } catch (err) {
      item.attempts++;
      item.lastError = err instanceof Error ? err.message : 'Network error';
      await updatePendingCapture(item);
      failed++;
    }
  }

  return { synced, failed };
}

/** Request a Background Sync if the API is available */
export async function requestBackgroundSync(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    if ('sync' in registration) {
      await (registration as unknown as { sync: { register(tag: string): Promise<void> } }).sync.register(SYNC_TAG);
      return true;
    }
  } catch {
    // Background Sync not supported or permission denied
  }
  return false;
}

// ─── Generic Offline Action Queue (#1528) ────────────────────────────────────

/**
 * Registry of action replay handlers.
 * Components register handlers that know how to replay a queued mutation
 * when the device comes back online.
 */
const actionHandlers = new Map<string, (payload: Record<string, unknown>) => Promise<void>>();

/**
 * Register a handler that replays a specific action type.
 * Call this at app startup for each mutation type you want to support offline.
 *
 * @example
 * ```ts
 * registerActionHandler('task.complete', async (payload) => {
 *   await fetch(`/api/tasks/${payload.id}`, {
 *     method: 'PATCH',
 *     body: JSON.stringify({ status: 'done' }),
 *   });
 * });
 * ```
 */
export function registerActionHandler(
  type: string,
  handler: (payload: Record<string, unknown>) => Promise<void>,
): void {
  actionHandlers.set(type, handler);
}

/** Remove a previously registered action handler */
export function unregisterActionHandler(type: string): void {
  actionHandlers.delete(type);
}

/** Queue a generic action for later replay */
export async function queueAction(input: QueueActionInput): Promise<OfflineAction> {
  const action: OfflineAction = {
    id: generateId(),
    type: input.type,
    payload: input.payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ACTION_STORE, 'readwrite');
    tx.objectStore(ACTION_STORE).add(action);
    tx.oncomplete = () => {
      db.close();
      // Notify listeners of queue change
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('offline-queue:changed'));
      }
      resolve(action);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Get all pending actions, ordered by creation time */
export async function getPendingActions(): Promise<OfflineAction[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ACTION_STORE, 'readonly');
    const index = tx.objectStore(ACTION_STORE).index('createdAt');
    const request = index.getAll();
    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/** Remove a successfully replayed action */
export async function removeAction(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ACTION_STORE, 'readwrite');
    tx.objectStore(ACTION_STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('offline-queue:changed'));
      }
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Update a pending action (e.g. increment attempts) */
export async function updateAction(action: OfflineAction): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ACTION_STORE, 'readwrite');
    tx.objectStore(ACTION_STORE).put(action);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Maximum number of retry attempts before an action is discarded */
const MAX_ACTION_ATTEMPTS = 5;

/**
 * Replay all pending actions using registered handlers.
 * Uses last-write-wins: actions are processed in creation order,
 * so the most recent action for a given entity naturally wins.
 *
 * Returns counts of synced and failed actions.
 */
export async function replayPendingActions(): Promise<{ synced: number; failed: number; dropped: number }> {
  const actions = await getPendingActions();
  let synced = 0;
  let failed = 0;
  let dropped = 0;

  for (const action of actions) {
    const handler = actionHandlers.get(action.type);

    if (!handler) {
      // No handler registered — skip but don't remove (handler may be registered later)
      failed++;
      continue;
    }

    // Drop actions that have exceeded max attempts
    if (action.attempts >= MAX_ACTION_ATTEMPTS) {
      await removeAction(action.id);
      dropped++;
      continue;
    }

    try {
      await handler(action.payload);
      await removeAction(action.id);
      synced++;
    } catch (err) {
      action.attempts++;
      action.lastError = err instanceof Error ? err.message : 'Replay error';
      await updateAction(action);
      failed++;
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('offline-queue:changed'));
  }

  return { synced, failed, dropped };
}

/**
 * Get the total count of all pending items (captures + actions).
 * Useful for showing a badge count in the UI.
 */
export async function getTotalPendingCount(): Promise<number> {
  const [captures, actions] = await Promise.all([
    getPendingCaptures(),
    getPendingActions(),
  ]);
  return captures.length + actions.length;
}
