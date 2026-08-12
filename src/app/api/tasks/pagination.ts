export const DEFAULT_TASK_PAGE_SIZE = 50;
export const MAX_TASK_PAGE_SIZE = 200;
export const MAX_TASK_OFFSET = 100_000;
export const SMART_SCORE_CANDIDATE_LIMIT = 1_000;

export type TaskPaginationResult =
  | { ok: true; limit: number; offset: number }
  | { ok: false; message: string };

function parseInteger(
  value: string | null,
  name: 'limit' | 'offset',
  defaultValue: number,
): number | string {
  if (value === null) return defaultValue;
  if (!/^\d+$/.test(value)) return `${name} must be a non-negative integer`;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return `${name} must be a safe integer`;
  return parsed;
}

export function parseTaskPagination(searchParams: URLSearchParams): TaskPaginationResult {
  const parsedLimit = parseInteger(searchParams.get('limit'), 'limit', DEFAULT_TASK_PAGE_SIZE);
  if (typeof parsedLimit === 'string') return { ok: false, message: parsedLimit };
  if (parsedLimit < 1 || parsedLimit > MAX_TASK_PAGE_SIZE) {
    return {
      ok: false,
      message: `limit must be between 1 and ${MAX_TASK_PAGE_SIZE}`,
    };
  }

  const parsedOffset = parseInteger(searchParams.get('offset'), 'offset', 0);
  if (typeof parsedOffset === 'string') return { ok: false, message: parsedOffset };
  if (parsedOffset > MAX_TASK_OFFSET) {
    return {
      ok: false,
      message: `offset must be between 0 and ${MAX_TASK_OFFSET}`,
    };
  }

  return { ok: true, limit: parsedLimit, offset: parsedOffset };
}
