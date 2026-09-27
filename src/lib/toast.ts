import { toast as sonnerToast, type ExternalToast } from 'sonner';
import { getToastPreferences } from '@/lib/toast-preferences';

type ToastMessage = Parameters<typeof sonnerToast>[0];
type ToastKind = 'success' | 'info' | 'message' | 'error' | 'warning';

export function isRoutineToast(options: ExternalToast): boolean {
  return !options.action && !options.cancel && options.dismissible !== false &&
    options.duration !== Infinity;
}

export function routineToastsMuted(): boolean {
  const preferences = getToastPreferences();
  return preferences.mode === 'errors-only' || preferences.mutedUntil > Date.now();
}

let nextId = 0;
const recent = new Map<string, { id: string | number; until: number }>();

function notify(kind: ToastKind | undefined, message: ToastMessage, options?: ExternalToast) {
  const routine = kind !== 'error' && kind !== 'warning' && isRoutineToast(options ?? {});
  if (routine && routineToastsMuted()) {
    // A successful update must still remove an earlier loading toast.
    if (options?.id !== undefined) sonnerToast.dismiss(options.id);
    return options?.id ?? `mc-muted-${++nextId}`;
  }

  const duration = options?.duration ?? (routine ? 3000 : 8000);
  const emit = kind ? sonnerToast[kind] : sonnerToast;
  // Explicit IDs, callbacks, and actions belong to their caller's lifecycle.
  const canGroup = options === undefined && typeof message === 'string';
  if (!canGroup) return emit(message, { ...options, duration });

  const now = Date.now();
  for (const [key, entry] of recent) {
    if (entry.until <= now) recent.delete(key);
  }
  const key = JSON.stringify([kind, message]);
  const previous = recent.get(key);
  const id = previous?.id ?? `mc-toast-${++nextId}`;
  // Do not keep extending a confirmation's lifetime during a burst.
  if (previous) return id;
  if (recent.size >= 100) recent.delete(recent.keys().next().value!);
  recent.set(key, { id, until: now + duration });
  const forget = () => {
    if (recent.get(key)?.id === id) recent.delete(key);
  };
  return emit(message, { id, duration, onDismiss: forget, onAutoClose: forget });
}

export const toast = Object.assign(
  (message: ToastMessage, options?: ExternalToast) => notify(undefined, message, options),
  {
    success: (message: ToastMessage, options?: ExternalToast) => notify('success', message, options),
    info: (message: ToastMessage, options?: ExternalToast) => notify('info', message, options),
    message: (message: ToastMessage, options?: ExternalToast) => notify('message', message, options),
    error: (message: ToastMessage, options?: ExternalToast) => notify('error', message, options),
    warning: (message: ToastMessage, options?: ExternalToast) => notify('warning', message, options),
    loading: sonnerToast.loading,
    dismiss: sonnerToast.dismiss,
  },
);
