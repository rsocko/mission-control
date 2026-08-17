import { toast } from 'sonner';
import { pushUndoWithToast } from '@/lib/stores/undoStore';

export interface BulkOperationResult {
  succeeded: string[];
  failed: string[];
}

export interface BulkOperationOptions {
  onSelectionChange?: (failedIds: string[]) => void;
  onRefresh?: () => void | Promise<void>;
  undo?: {
    label: string;
    operation: (id: string) => Promise<Response | void>;
  };
}

/**
 * Execute an async operation on each id, tracking successes and failures.
 * Shows a toast summary and returns which ids failed so the caller can
 * keep them selected.
 */
export async function executeBulkOperation(
  ids: string[],
  operation: (id: string) => Promise<Response | void>,
  successMessage: string,
  options: BulkOperationOptions = {},
): Promise<BulkOperationResult> {
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const id of ids) {
    try {
      const res = await operation(id);
      if (res && !res.ok) {
        failed.push(id);
      } else {
        succeeded.push(id);
      }
    } catch {
      failed.push(id);
    }
  }

  if (failed.length === 0 && !options.undo) {
    toast.success(successMessage);
  } else if (succeeded.length === 0) {
    toast.error(`All ${ids.length} operations failed`);
  } else {
    toast.warning(`${succeeded.length} succeeded, ${failed.length} failed`);
  }

  const result = { succeeded, failed };
  options.onSelectionChange?.(failed);
  await options.onRefresh?.();

  if (succeeded.length > 0 && options.undo) {
    const { label, operation: undoOperation } = options.undo;
    pushUndoWithToast(label, async () => {
      const undoResult = await executeBulkOperation(
        succeeded,
        undoOperation,
        `Undid ${succeeded.length} operation${succeeded.length === 1 ? '' : 's'}`,
        { onRefresh: options.onRefresh },
      );
      if (undoResult.failed.length > 0) {
        throw new Error(`Failed to undo ${undoResult.failed.length} operation${undoResult.failed.length === 1 ? '' : 's'}`);
      }
    });
  }

  return result;
}
