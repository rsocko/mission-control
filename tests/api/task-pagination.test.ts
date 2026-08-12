import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_PAGE_SIZE,
  MAX_TASK_OFFSET,
  MAX_TASK_PAGE_SIZE,
  parseTaskPagination,
} from '@/app/api/tasks/pagination';

describe('task pagination limits', () => {
  it('uses bounded defaults', () => {
    expect(parseTaskPagination(new URLSearchParams())).toEqual({
      ok: true,
      limit: DEFAULT_TASK_PAGE_SIZE,
      offset: 0,
    });
  });

  it('accepts the maximum page size and deep safe offsets', () => {
    expect(parseTaskPagination(new URLSearchParams({
      limit: String(MAX_TASK_PAGE_SIZE),
      offset: String(MAX_TASK_OFFSET),
    }))).toEqual({
      ok: true,
      limit: MAX_TASK_PAGE_SIZE,
      offset: MAX_TASK_OFFSET,
    });
  });

  it.each([
    ['0', '0'],
    ['201', '0'],
    ['Infinity', '0'],
    ['10.5', '0'],
    ['-1', '0'],
    ['10', '-1'],
    ['10', 'NaN'],
    ['10', String(MAX_TASK_OFFSET + 1)],
  ])('rejects limit=%s offset=%s', (limit, offset) => {
    expect(parseTaskPagination(new URLSearchParams({ limit, offset })).ok).toBe(false);
  });
});
