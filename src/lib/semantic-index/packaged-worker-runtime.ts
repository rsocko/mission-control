import { semanticIndexLogger } from '@/lib/logger';
import {
  parseSavedAIProviderConfig,
  resolveAIConfig,
} from '@/lib/ai/config-values';
import {
  DEFAULT_AI_ROUTING_POLICY,
  resolveSensitivity,
  validateAIRoutingPolicy,
} from '@/lib/ai/sensitivity-policy';
import type { AIRoutingPolicyConfig } from '@/lib/ai/types';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { buildEmbeddingConfig } from '@/lib/search/embedding-config';
import {
  getPostgresSemanticIndexRepository,
  getPostgresSemanticSourcePort,
} from '@/db/runtime';
import { AIEmbeddingProvider } from './embedding-provider';
import type { SemanticPublishResult } from './service';
import { SemanticIndexService } from './service';
import type { SemanticIndexRepository } from './contracts';
import {
  SEMANTIC_SOURCE_ENTITY_TYPES,
  type SemanticSourcePort,
  type SemanticSourceEntityType,
} from './source/contracts';
import { SemanticIndexWorker } from './worker';
import { resolveSemanticWorkerConfig } from './worker-config';

const SETTINGS_KEY = 'ai_provider_config';
const ROUTING_POLICY_SETTINGS_KEY = 'ai_routing_policy';
const REQUIRED_SEMANTIC_REPOSITORY_METHODS: readonly (
  keyof SemanticIndexRepository
)[] = [
  'createIdentity',
  'getIdentity',
  'getActiveIdentity',
  'listIdentities',
  'markIdentityReady',
  'markIdentityFailed',
  'activateIdentity',
  'rollbackToIdentity',
  'retireIdentity',
  'cleanupIdentities',
  'upsertDocument',
  'getDocument',
  'listDocuments',
  'deleteDocument',
  'expireDocuments',
  'purgeDeletedDocuments',
  'upsertVector',
  'getVector',
  'deleteVector',
  'queryVectors',
  'enqueueIntent',
  'claimIntents',
  'renewIntentLease',
  'completeIntent',
  'failIntent',
  'getIntent',
  'recoverExpiredIntentLeases',
  'pruneIntents',
  'createRun',
  'claimRun',
  'renewRunLease',
  'checkpointRun',
  'releaseRun',
  'completeRun',
  'failRun',
  'getRun',
  'recoverExpiredRunLeases',
  'getMetrics',
  'getReadiness',
];
const REQUIRED_SEMANTIC_SOURCE_METHODS: readonly (keyof SemanticSourcePort)[] = [
  'get',
  'listIds',
  'list',
  'listExisting',
];

export interface PackagedPostgresSemanticRuntime {
  worker: SemanticIndexWorker;
  service: SemanticIndexService;
  enabledEntityTypes: ReadonlySet<SemanticSourceEntityType>;
  isCapabilityActive(): boolean;
}

let runtime: PackagedPostgresSemanticRuntime | null = null;
let runtimePromise: Promise<PackagedPostgresSemanticRuntime> | null = null;
let runtimeGeneration = 0;
const activePublications = new Set<Promise<SemanticPublishResult>>();

function parseRoutingPolicy(value: unknown): AIRoutingPolicyConfig {
  if (value === null) return DEFAULT_AI_ROUTING_POLICY;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return validateAIRoutingPolicy(parsed);
}

function workerDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(
    process.env.MC_SEMANTIC_INDEX_WORKER_DISABLED?.trim() ?? '',
  );
}

function assertMethods<T extends object>(
  value: T,
  methods: readonly (keyof T)[],
  label: string,
): void {
  const missing = methods.filter((method) => typeof value[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`${label} is incomplete: ${missing.join(', ')}`);
  }
}

export async function createPackagedPostgresSemanticRuntime(
  isCapabilityActive: () => boolean = () => true,
): Promise<PackagedPostgresSemanticRuntime> {
  if (runtime) return runtime;
  if (!runtimePromise) {
    const compositionGeneration = runtimeGeneration;
    runtimePromise = (async () => {
      const settings = getCorePersistenceRepositories().settings;
      const [savedValue, routingPolicyValue] = await Promise.all([
        settings.get(SETTINGS_KEY),
        settings.get(ROUTING_POLICY_SETTINGS_KEY),
      ]);
      const resolved = resolveAIConfig(parseSavedAIProviderConfig(savedValue));
      const policy = parseRoutingPolicy(routingPolicyValue);
      const entityTypes = SEMANTIC_SOURCE_ENTITY_TYPES.filter((entityType) =>
        entityType === 'houston-summary'
          ? resolved.houstonMemoryEnabled
          : resolved.semanticSearchEnabled
      );
      const enabledEntityTypes = new Set(entityTypes);
      const config = resolveSemanticWorkerConfig(entityTypes);
      if (
        enabledEntityTypes.size > 0
        && !buildEmbeddingConfig(resolved, policy)
      ) {
        throw new Error(
          'PostgreSQL semantic indexing is enabled but its embedding provider is not configured',
        );
      }
      const repository = getPostgresSemanticIndexRepository();
      const source = getPostgresSemanticSourcePort();
      assertMethods(
        repository,
        REQUIRED_SEMANTIC_REPOSITORY_METHODS,
        'PostgreSQL semantic repository',
      );
      assertMethods(
        source,
        REQUIRED_SEMANTIC_SOURCE_METHODS,
        'PostgreSQL semantic source',
      );
      const embeddings = new AIEmbeddingProvider({
        getEmbeddingConfig: async (sources = [], options = {}) =>
          buildEmbeddingConfig(resolved, policy, sources, options),
      });
      const service = new SemanticIndexService({
        repository,
        source,
        embeddings,
        resolveSensitivity: ({ connectorType }) => resolveSensitivity(
          'semantic-embedding',
          policy,
          { sources: connectorType ? [connectorType.trim().toLowerCase()] : [] },
        ),
        embeddingTimeoutMs: config.embeddingTimeoutMs,
      });
      const worker = new SemanticIndexWorker({
        repository,
        source,
        embeddings,
        service,
        config,
        isEnabled: () =>
          isCapabilityActive() && !workerDisabled() && enabledEntityTypes.size > 0,
        enabledEntityTypes: () => config.entityTypes,
      });
      if (compositionGeneration !== runtimeGeneration) {
        await worker.stop();
        throw new Error('Packaged PostgreSQL semantic runtime composition was invalidated');
      }
      runtime = { worker, service, enabledEntityTypes, isCapabilityActive };
      return runtime;
    })();
  }
  const pending = runtimePromise;
  try {
    return await pending;
  } finally {
    if (runtimePromise === pending) runtimePromise = null;
  }
}

export function startPackagedPostgresSemanticWorker(
  composed: PackagedPostgresSemanticRuntime,
): void {
  if (runtime !== composed) {
    throw new Error('Packaged PostgreSQL semantic runtime was not composed');
  }
  composed.worker.start();
}

export async function stopPackagedPostgresSemanticWorker(): Promise<void> {
  runtimeGeneration++;
  const pending = runtimePromise;
  const current = runtime;
  runtime = null;
  if (pending) await pending.catch(() => undefined);
  if (runtimePromise === pending) runtimePromise = null;
  await Promise.allSettled(activePublications);
  if (current) await current.worker.stop();
}

export async function publishPackagedPostgresSemanticEntity(
  kind: 'upsert' | 'delete',
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult> {
  const publicationGeneration = runtimeGeneration;
  const current = runtime ?? await createPackagedPostgresSemanticRuntime();
  if (
    publicationGeneration !== runtimeGeneration
    || current !== runtime
  ) {
    return { status: 'skipped', reason: 'runtime-shutdown' };
  }
  if (
    !current.isCapabilityActive()
    || workerDisabled()
    || !current.enabledEntityTypes.has(entityType)
  ) {
    return { status: 'skipped', reason: 'semantic-search-disabled' };
  }
  const publication = Promise.resolve().then(() =>
    current.service.publish({ kind, entityType, entityId })
  );
  activePublications.add(publication);
  try {
    return await publication;
  } catch (error) {
    semanticIndexLogger.warn({
      event: 'semantic_publish_failed',
      kind,
      entityType,
      entityId,
      err: error,
    }, 'Failed to publish PostgreSQL semantic index intent');
    return { status: 'skipped', reason: 'publish-failed' };
  } finally {
    activePublications.delete(publication);
  }
}
