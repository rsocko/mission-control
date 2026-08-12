import { describe, expect, it } from 'vitest';
import {
  literalContainsPattern,
  normalizedCsv,
  TASK_QUERY_LIMITS,
  TaskQueryValidationError,
  validateTaskQueryParams,
} from '@/app/api/tasks/query-input';

describe('task query input budgets', () => {
  it('normalizes and deduplicates comma-separated filters', () => {
    const params = new URLSearchParams({ tagIds: ' tag-1,tag-1,tag-2 ' });
    expect(normalizedCsv(params, 'tagIds')).toEqual(['tag-1', 'tag-2']);
  });

  it('rejects over-budget multi-value and structured filters', () => {
    const tooManyValues = Array.from(
      { length: TASK_QUERY_LIMITS.filterValues + 1 },
      (_, index) => `tag-${index}`,
    );
    expect(() => validateTaskQueryParams(new URLSearchParams({
      tagIds: tooManyValues.join(','),
    }))).toThrow(TaskQueryValidationError);
    expect(() => validateTaskQueryParams(new URLSearchParams({
      filterQuery: tooManyValues.map((value) => `tag:${value}`).join(' '),
    }))).toThrow('tag values');
    expect(() => validateTaskQueryParams(new URLSearchParams({
      tag: 'x'.repeat(TASK_QUERY_LIMITS.filterValueCharacters + 1),
    }))).toThrow('tag cannot exceed');
  });

  it('counts Unicode characters rather than UTF-16 code units', () => {
    const allowed = '😀'.repeat(TASK_QUERY_LIMITS.searchCharacters);
    expect(() => validateTaskQueryParams(new URLSearchParams({ search: allowed }))).not.toThrow();
    expect(() => validateTaskQueryParams(new URLSearchParams({
      search: `${allowed}😀`,
    }))).toThrow(`search cannot exceed ${TASK_QUERY_LIMITS.searchCharacters} characters`);
  });

  it('escapes SQL wildcard input for literal substring matching', () => {
    expect(literalContainsPattern('50%_done!later')).toBe('%50!%!_done!!later%');
  });
});
