import { toast } from 'sonner';

interface BulkOperationResult {
  succeeded: string[];
  failed: string[];
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

  if (failed.length === 0) {
    toast.success(successMessage);
  } else if (succeeded.length === 0) {
    toast.error(`All ${ids.length} operations failed`);
  } else {
    toast.warning(`${succeeded.length} succeeded, ${failed.length} failed`);
  }

  return { succeeded, failed };
}
