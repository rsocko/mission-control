import { create } from 'zustand';
import { toast } from 'sonner';

export interface UndoEntry {
  id: string;
  label: string;
  undo: () => void | Promise<void>;
  createdAt: number;
}

const MAX_QUEUE_SIZE = 20;
const UNDO_WINDOW_MS = 5000;

interface UndoState {
  queue: UndoEntry[];
  pushUndo: (entry: Omit<UndoEntry, 'id' | 'createdAt'>) => string;
  popUndo: () => UndoEntry | null;
  takeEntry: (id: string) => UndoEntry | null;
  removeEntry: (id: string) => void;
  clear: () => void;
}

let entryCounter = 0;

export const useUndoStore = create<UndoState>((set, get) => ({
  queue: [],

  pushUndo(entry) {
    const id = `undo-${++entryCounter}-${Date.now()}`;
    const now = Date.now();

    set((state) => {
      // Evict expired entries and cap at MAX_QUEUE_SIZE - 1 to make room
      const fresh = state.queue
        .filter((e) => now - e.createdAt < UNDO_WINDOW_MS)
        .slice(-(MAX_QUEUE_SIZE - 1));

      return { queue: [...fresh, { ...entry, id, createdAt: now }] };
    });

    // Auto-expire this entry after the undo window
    setTimeout(() => {
      set((state) => ({ queue: state.queue.filter((e) => e.id !== id) }));
    }, UNDO_WINDOW_MS);

    return id;
  },

  popUndo() {
    const { queue } = get();
    const now = Date.now();

    // Find the most recent entry still within the undo window
    for (let i = queue.length - 1; i >= 0; i--) {
      if (now - queue[i].createdAt < UNDO_WINDOW_MS) {
        const entry = queue[i];
        set((state) => ({ queue: state.queue.filter((e) => e.id !== entry.id) }));
        return entry;
      }
    }
    return null;
  },

  removeEntry(id) {
    set((state) => ({ queue: state.queue.filter((e) => e.id !== id) }));
  },

  takeEntry(id) {
    const { queue } = get();
    const entry = queue.find((e) => e.id === id);
    if (!entry) return null;
    set((state) => ({ queue: state.queue.filter((e) => e.id !== id) }));
    return entry;
  },

  clear() {
    set({ queue: [] });
  },
}));

/**
 * Push an undo action and show a Sonner toast with an Undo button.
 * Guards against double-execution: if Ctrl+Z already consumed the entry,
 * clicking the toast Undo button is a no-op.
 * Returns the entry ID so callers can remove it if needed.
 */
export function pushUndoWithToast(
  label: string,
  undoFn: () => void | Promise<void>,
  options?: {
    type?: 'success' | 'info';
    validationError?: () => string | null;
  },
) {
  const entryId = useUndoStore.getState().pushUndo({ label, undo: undoFn });

  const toastFn = options?.type === 'info' ? toast : toast.success;
  toastFn(label, {
    id: entryId,
    action: {
      label: 'Undo',
      onClick: () => {
        const validationError = options?.validationError?.();
        if (validationError) {
          toast.error(validationError);
          return;
        }
        // Atomically try to consume the entry; no-op if already consumed by Ctrl+Z
        const taken = useUndoStore.getState().takeEntry(entryId);
        if (taken) {
          void Promise.resolve(undoFn()).catch(() => {
            toast.error('Undo failed');
          });
        }
      },
    },
    duration: 5000,
  });

  return entryId;
}

/**
 * Execute the most recent undo action (for Ctrl+Z).
 * Returns true if an action was undone.
 */
export function executeUndo(): boolean {
  const entry = useUndoStore.getState().popUndo();
  if (!entry) {
    toast.info('Nothing to undo', { duration: 2000 });
    return false;
  }
  toast.info(`Undone: ${entry.label}`, { duration: 3000 });
  void Promise.resolve(entry.undo()).catch(() => {
    toast.error('Undo failed');
  });
  return true;
}
