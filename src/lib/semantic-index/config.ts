/**
 * Worker/service tunables for the durable semantic index.
 *
 * Every bound is explicit and every default is conservative: the index worker
 * shares a process with the sync worker, so it must never be able to consume
 * the whole event loop, hold a lease past its heartbeat, or run forever.
 */

import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
import {
  SEMANTIC_SOURCE_ENTITY_TYPES,
  type SemanticSourceEntityType,
} from './source/contracts';
import {
  resolveSemanticWorkerConfig,
  type SemanticWorkerConfig,
} from './worker-config';

export type { SemanticWorkerConfig } from './worker-config';

export function getSemanticWorkerConfig(): SemanticWorkerConfig {
  const ai = getResolvedAIConfig();
  const entityTypes = SEMANTIC_SOURCE_ENTITY_TYPES.filter((entityType) =>
    entityType === 'houston-summary'
      ? ai.houstonMemoryEnabled
      : ai.semanticSearchEnabled
  );
  return resolveSemanticWorkerConfig(entityTypes);
}

/**
 * The index is only maintained when semantic search enrichment is switched on.
 * When it is off the worker still starts, but parks immediately and performs no
 * reads, writes, or provider calls.
 */
export function isSemanticIndexEnabled(): boolean {
  if (/^(1|true|yes|on)$/i.test(process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED?.trim() ?? '')) {
    return false;
  }
  try {
    const config = getResolvedAIConfig();
    return Boolean(config.semanticSearchEnabled || config.houstonMemoryEnabled);
  } catch {
    // A settings read can fail before the database exists; treat that as "not
    // enabled yet" rather than crashing the host worker process.
    return false;
  }
}

export function isSemanticEntityTypeEnabled(entityType: SemanticSourceEntityType): boolean {
  try {
    const config = getResolvedAIConfig();
    return entityType === 'houston-summary'
      ? config.houstonMemoryEnabled
      : config.semanticSearchEnabled;
  } catch {
    return false;
  }
}
