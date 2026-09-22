import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createPostgresSemanticIndexRepository } from '@/db/postgres/semantic-index/repository';
import { createPostgresSemanticSourcePort } from '@/db/postgres/semantic-index/source-port';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { assertNonProductionDatabaseTarget } from '@/lib/non-production-database-target';
import {
  createAIRequestContext,
  DEFAULT_AI_ROUTING_POLICY,
  resolveSensitivity,
} from '@/lib/ai/sensitivity-policy';
import { AIEmbeddingProvider } from '@/lib/semantic-index/embedding-provider';
import { SemanticIndexService } from '@/lib/semantic-index/service';
import {
  SEMANTIC_SOURCE_ENTITY_TYPES,
  type SemanticSourceEntityType,
} from '@/lib/semantic-index/source/contracts';
import { SemanticIndexWorker } from '@/lib/semantic-index/worker';
import { resolveSemanticWorkerConfig } from '@/lib/semantic-index/worker-config';
import { semanticIndexLogger } from '@/lib/logger';

const HARNESS_TOKEN = 'postgres-integration-test';

function entityTypes(): readonly SemanticSourceEntityType[] {
  const configured = process.env.MC_SEMANTIC_HARNESS_ENTITY_TYPES
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configured?.length) return SEMANTIC_SOURCE_ENTITY_TYPES;
  const invalid = configured.filter(
    (value) => !SEMANTIC_SOURCE_ENTITY_TYPES.includes(value as SemanticSourceEntityType),
  );
  if (invalid.length > 0) {
    throw new Error(`Unsupported semantic harness entity types: ${invalid.join(', ')}`);
  }
  return configured as SemanticSourceEntityType[];
}

function assertHarnessEnvironment(): {
  connectionString: string;
  endpoint: string;
  provider: string;
  model: string;
} {
  if (
    process.env.NODE_ENV !== 'test'
    || process.env.MC_SEMANTIC_PACKAGED_HARNESS !== HARNESS_TOKEN
  ) {
    throw new Error('Packaged semantic worker harness is restricted to explicit test execution');
  }
  if (process.env.MC_DATABASE_BACKEND !== 'postgres') {
    throw new Error('Packaged semantic worker harness requires MC_DATABASE_BACKEND=postgres');
  }
  const connectionString = process.env.MC_POSTGRES_URL;
  if (
    !connectionString
    || !process.env.MC_TEST_POSTGRES_URL
    || connectionString !== process.env.MC_TEST_POSTGRES_URL
  ) {
    throw new Error('Packaged semantic worker harness requires the guarded test PostgreSQL URL');
  }
  assertNonProductionDatabaseTarget(connectionString, ['postgres:', 'postgresql:']);
  const baseUrl = process.env.AI_EMBEDDING_BASE_URL;
  const provider = process.env.AI_EMBEDDING_PROVIDER;
  const model = process.env.AI_EMBEDDING_MODEL;
  if (!baseUrl || !provider || !model) {
    throw new Error('Packaged semantic worker harness requires an explicit embedding route');
  }
  const endpoint = new URL('embeddings', `${baseUrl.replace(/\/?$/, '/')}`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname)) {
    throw new Error('Packaged semantic worker harness embedding route must be loopback-only');
  }
  return { connectionString, endpoint: endpoint.toString(), provider, model };
}

async function main(): Promise<void> {
  process.env.MC_PROCESS_ROLE = 'worker';
  const readyFile = process.env.MC_SEMANTIC_HARNESS_READY_FILE;
  if (readyFile) rmSync(readyFile, { force: true });
  const route = assertHarnessEnvironment();
  const backend = new PostgresPersistenceBackend({
    config: resolvePostgresConfig({
      ...process.env,
      MC_POSTGRES_URL: route.connectionString,
      MC_POSTGRES_APPLICATION_NAME: 'mission-control-semantic-packaged-harness',
    }),
  });
  await backend.initialize();
  const repository = createPostgresSemanticIndexRepository(
    backend.context.pool,
    backend.context.vector,
  );
  const source = createPostgresSemanticSourcePort(backend.context.pool);
  const embeddings = new AIEmbeddingProvider({
    getEmbeddingConfig: async (sources = [], options = {}) => ({
      provider: route.provider,
      model: route.model,
      endpoint: route.endpoint,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.AI_EMBEDDING_API_KEY
          ? { Authorization: `Bearer ${process.env.AI_EMBEDDING_API_KEY}` }
          : {}),
      },
      context: createAIRequestContext(
        'semantic-embedding',
        DEFAULT_AI_ROUTING_POLICY,
        {
          sources,
          override: options.sensitivityOverride,
          correlationId: randomUUID(),
        },
      ),
    }),
  });
  const config = resolveSemanticWorkerConfig(entityTypes());
  const service = new SemanticIndexService({
    repository,
    source,
    embeddings,
    resolveSensitivity: ({ connectorType }) => resolveSensitivity(
      'semantic-embedding',
      DEFAULT_AI_ROUTING_POLICY,
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
    isEnabled: () => true,
    enabledEntityTypes: () => config.entityTypes,
    onRunCheckpointed: process.env.MC_SEMANTIC_HARNESS_CRASH_AFTER_RUN_CHECKPOINT === '1'
      ? (_run, result) => {
          if (result.checkpoint !== null) process.kill(process.pid, 'SIGKILL');
        }
      : undefined,
  });
  const keepAlive = setInterval(() => undefined, 60_000);
  worker.start();
  if (readyFile) {
    writeFileSync(readyFile, String(process.pid), { encoding: 'utf8', mode: 0o600 });
  }
  semanticIndexLogger.info(
    { event: 'semantic_packaged_harness_ready', entityTypes: config.entityTypes },
    'Packaged PostgreSQL semantic worker harness ready',
  );

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) return;
    shutdownPromise = (async () => {
      clearInterval(keepAlive);
      if (readyFile) rmSync(readyFile, { force: true });
      await worker.stop();
      await backend.shutdown();
      semanticIndexLogger.info(
        { event: 'semantic_packaged_harness_stopped', signal },
        'Packaged PostgreSQL semantic worker harness stopped',
      );
    })().then(
      () => process.exit(0),
      (error) => {
        console.error('Packaged semantic worker harness shutdown failed', error);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void main().catch((error) => {
  console.error('Packaged semantic worker harness failed to start', error);
  process.exit(1);
});
