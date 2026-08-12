import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { parseFilterQuery } from '@/lib/utils/parseFilterQuery';

export const TASK_QUERY_LIMITS = {
  searchCharacters: 200,
  filterQueryCharacters: 512,
  filterValues: 20,
  filterTokens: 50,
  filterValueCharacters: 128,
} as const;

const MULTI_VALUE_PARAMS = [
  'sources',
  'statuses',
  'priorities',
  'localDispositions',
  'listIds',
  'tagSlugs',
  'tagIds',
] as const;

const SINGLE_VALUE_PARAMS = [
  'tag',
  'source',
  'listId',
  'listGroupId',
  'projectId',
  'groupValue',
] as const;

export class TaskQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskQueryValidationError';
  }
}

export function validateTaskQueryParams(searchParams: URLSearchParams): void {
  validateLength('search', searchParams.get('search'), TASK_QUERY_LIMITS.searchCharacters);

  const filterQuery = searchParams.get('filterQuery')?.trim();
  validateLength('filterQuery', filterQuery, TASK_QUERY_LIMITS.filterQueryCharacters);

  for (const key of MULTI_VALUE_PARAMS) {
    normalizedCsv(searchParams, key);
  }
  for (const key of SINGLE_VALUE_PARAMS) {
    validateLength(key, searchParams.get(key), TASK_QUERY_LIMITS.filterValueCharacters);
  }

  if (!filterQuery) return;

  const parsed = parseFilterQuery(filterQuery);
  const uniqueTokens = new Set(
    parsed.tokens.map((token) => `${token.negated ? '-' : '+'}:${token.type}:${token.value}`),
  );
  if (uniqueTokens.size > TASK_QUERY_LIMITS.filterTokens) {
    throw new TaskQueryValidationError(
      `filterQuery cannot contain more than ${TASK_QUERY_LIMITS.filterTokens} filters`,
    );
  }

  const valuesByType = new Map<string, Set<string>>();
  for (const token of parsed.tokens) {
    validateLength(
      `filterQuery ${token.type} value`,
      token.value,
      TASK_QUERY_LIMITS.filterValueCharacters,
    );
    const key = `${token.negated ? '-' : '+'}:${token.type}`;
    const values = valuesByType.get(key) ?? new Set<string>();
    values.add(token.value);
    valuesByType.set(key, values);
    if (values.size > TASK_QUERY_LIMITS.filterValues) {
      throw new TaskQueryValidationError(
        `filterQuery cannot contain more than ${TASK_QUERY_LIMITS.filterValues} ${token.type} values`,
      );
    }
  }
}

export function normalizedCsv(
  searchParams: URLSearchParams,
  key: string,
  validValues?: { has: (value: string) => boolean },
): string[] {
  const raw = searchParams.get(key) ?? '';
  validateLength(
    key,
    raw,
    TASK_QUERY_LIMITS.filterValues * (TASK_QUERY_LIMITS.filterValueCharacters + 1),
  );
  const values = unique(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value && (!validValues || validValues.has(value))),
  );
  if (values.length > TASK_QUERY_LIMITS.filterValues) {
    throw new TaskQueryValidationError(
      `${key} cannot contain more than ${TASK_QUERY_LIMITS.filterValues} values`,
    );
  }
  for (const value of values) {
    validateLength(key, value, TASK_QUERY_LIMITS.filterValueCharacters);
  }
  return values;
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function containsLiteral(column: AnyColumn, value: string): SQL {
  return sql`${column} LIKE ${literalContainsPattern(value)} ESCAPE '!'`;
}

export function literalContainsPattern(value: string): string {
  return `%${value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
}

function validateLength(name: string, value: string | null | undefined, maximum: number): void {
  if (value && Array.from(value).length > maximum) {
    throw new TaskQueryValidationError(`${name} cannot exceed ${maximum} characters`);
  }
}
