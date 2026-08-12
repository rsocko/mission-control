import {
  DEFAULT_UNIVERSE_DIMENSIONS,
  UNIVERSE_DIMENSIONS,
  type UniverseDimension,
  type UniverseGraphFilters,
} from './universe-types';
import { GraphQueryValidationError } from './query';
import { getUniverseSubgraph } from './universe-service';

export const getFilteredSubgraph = getUniverseSubgraph;

function csv(searchParams: URLSearchParams, key: string): string[] {
  const values = (searchParams.get(key) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > 50 || values.some((value) => value.length > 200)) {
    throw new GraphQueryValidationError(`${key} contains too many or overly long values`);
  }
  return values;
}

function optionalNumber(searchParams: URLSearchParams, key: string): number | undefined {
  const raw = searchParams.get(key);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new GraphQueryValidationError(`${key} must be a finite number`);
  }

  return value;
}

const CANONICAL_TASK_QUERY_KEYS = new Set([
  'openOnly',
  'source',
  'sources',
  'listId',
  'listIds',
  'listGroupId',
  'tag',
  'tagSlugs',
  'projectId',
  'priorities',
  'statuses',
  'quickFilter',
  'myDayDate',
  'filterQuery',
  'ageMin',
  'ageMax',
]);

export function parseFilteredSubgraphSearchParams(
  searchParams: URLSearchParams,
): UniverseGraphFilters {
  const requestedDimensions = csv(searchParams, 'dimensions');
  const invalidDimensions = requestedDimensions.filter(
    (dimension) => !UNIVERSE_DIMENSIONS.includes(dimension as UniverseDimension),
  );
  if (invalidDimensions.length) {
    throw new GraphQueryValidationError(
      `Unsupported dimensions: ${invalidDimensions.join(', ')}`,
    );
  }
  const dimensions = (requestedDimensions.length
    ? requestedDimensions
    : DEFAULT_UNIVERSE_DIMENSIONS) as UniverseDimension[];
  if (!dimensions.length) {
    throw new GraphQueryValidationError('At least one valid dimension is required');
  }
  const taskQuery = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (!CANONICAL_TASK_QUERY_KEYS.has(key)) continue;
    if (value.length > 1000) {
      throw new GraphQueryValidationError(`${key} is too long`);
    }
    taskQuery.append(key, value);
  }
  return {
    dimensions,
    taskQuery,
    maxNodes: optionalNumber(searchParams, 'maxNodes'),
    maxEdges: optionalNumber(searchParams, 'maxEdges'),
  };
}
