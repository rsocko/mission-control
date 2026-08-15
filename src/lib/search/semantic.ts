import { sqlite } from '@/db';
import {
  AIRoutingDeniedError,
  getAIRequestContext,
  getAIRouteOutcome,
  getAIRoutingHeaders,
  getResolvedAIConfig,
  type AIRequestContext,
} from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import type {
  SearchResult,
  SearchableNotificationRecord,
  SearchableTaskRecord,
} from './fts';
import {
  EmbeddingCache,
  type EmbeddingCacheEntry,
} from './embedding-cache';

type SearchScope = 'tasks' | 'notifications' | 'all';
type EmbeddingEntityType = 'task' | 'alert';

interface EmbeddingConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  context: AIRequestContext;
}

let embeddingsTableReady = false;
let embeddingsSeedSignature: string | null = null;
let rebuildPromise: Promise<void> | null = null;
let rebuildBarrier: Promise<void> | null = null;
let routeRetryAfter = 0;
let routeRetryFailures = 0;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeLimit(limit = 20) {
  return Math.max(1, Math.min(limit, 50));
}

function truncate(text: string | null | undefined, max = 160) {
  const value = (text ?? '').trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function buildTaskHref(id: string) {
  return `/?taskId=${encodeURIComponent(id)}`;
}

function buildNotificationHref(id: string) {
  return `/notifications?id=${encodeURIComponent(id)}`;
}

const CACHE_MAX_ENTRIES = positiveInteger(
  process.env.MC_SEMANTIC_CACHE_MAX_ENTRIES,
  2_048,
);
const CACHE_MAX_BYTES = positiveInteger(
  process.env.MC_SEMANTIC_CACHE_MAX_BYTES,
  32 * 1024 * 1024,
);
const SEARCH_MAX_CANDIDATES = positiveInteger(
  process.env.MC_SEMANTIC_SEARCH_MAX_CANDIDATES,
  2_000,
);
const CANDIDATE_PAGE_SIZE = Math.min(
  positiveInteger(process.env.MC_SEMANTIC_SEARCH_PAGE_SIZE, 250),
  500,
);
const embeddingCache = new EmbeddingCache(CACHE_MAX_ENTRIES, CACHE_MAX_BYTES);
const ROUTE_RETRY_BASE_MS = positiveInteger(
  process.env.MC_SEMANTIC_ROUTE_RETRY_BASE_MS,
  30_000,
);
const ROUTE_RETRY_MAX_MS = positiveInteger(
  process.env.MC_SEMANTIC_ROUTE_RETRY_MAX_MS,
  5 * 60_000,
);

const searchMetrics = {
  searches: 0,
  totalCandidates: 0,
  lastCandidates: 0,
  saturatedSearches: 0,
  durationsMs: [] as number[],
};

function computeNorm(vec: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

function cosineSimilarityWithNorm(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  normB: number,
) {
  let dot = 0;
  let normA = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
  }

  const denominator = Math.sqrt(normA) * normB;
  return denominator === 0 ? 0 : dot / denominator;
}

const SIMILARITY_THRESHOLD = 0.25;

function getDefaultEmbeddingModel(provider: string) {
  if (process.env.AI_EMBEDDING_MODEL) {
    return process.env.AI_EMBEDDING_MODEL;
  }

  if (provider === 'ollama') return 'nomic-embed-text';
  if (provider === 'bifrost') return 'ollama/nomic-embed-text:latest';
  return 'text-embedding-3-small';
}

function getAzureEmbeddingEndpoint(baseUrl: string, deployment: string) {
  const normalizedBaseUrl = baseUrl
    .replace(/\/$/, '')
    .replace(/\/openai\/v1$/, '')
    .replace(/\/openai\/deployments\/[^/]+$/, '');
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';

  return `${normalizedBaseUrl}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`;
}

async function getEmbeddingConfig(sources: string[] = []): Promise<EmbeddingConfig | null> {
  const resolved = getResolvedAIConfig();
  const provider = resolved.provider;
  const model = getDefaultEmbeddingModel(provider);
  const context = getAIRequestContext('semantic-embedding', { sources });
  const routingHeaders = getAIRoutingHeaders(
    context,
    provider,
    resolved.baseUrl,
    Boolean(resolved.apiKey),
    model,
  );

  if (provider === 'azure') {
    if (!resolved.baseUrl || !resolved.apiKey) {
      return null;
    }

    return {
      provider,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model,
      endpoint: getAzureEmbeddingEndpoint(resolved.baseUrl, model),
      headers: {
        'Content-Type': 'application/json',
        'api-key': resolved.apiKey,
        ...routingHeaders,
      },
      context,
    };
  }

  if (!resolved.configured) {
    return null;
  }

  return {
    provider,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model,
    endpoint: resolved.baseUrl
      ? `${resolved.baseUrl.replace(/\/$/, '')}/embeddings`
      : 'https://api.openai.com/v1/embeddings',
    headers: {
      'Content-Type': 'application/json',
      ...routingHeaders,
      ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
    },
    context,
  };
}

export async function getSemanticSearchStatus() {
  const config = await getEmbeddingConfig();
  if (config) {
    return { available: true as const };
  }

  return {
    available: false as const,
    note: 'Semantic search is unavailable until an AI embedding provider is configured.',
  };
}

async function ensureEmbeddingsTable() {
  if (embeddingsTableReady) {
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS search_embeddings (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      source_sort_at TEXT
    );
  `);
  const columns = sqlite.prepare('PRAGMA table_info(search_embeddings)').all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has('provider')) {
    sqlite.exec('ALTER TABLE search_embeddings ADD COLUMN provider TEXT');
  }
  if (!columnNames.has('model')) {
    sqlite.exec('ALTER TABLE search_embeddings ADD COLUMN model TEXT');
  }
  const sourceSortAdded = !columnNames.has('source_sort_at');
  if (sourceSortAdded) {
    sqlite.exec('ALTER TABLE search_embeddings ADD COLUMN source_sort_at TEXT');
  }
  sqlite.exec(`
    DROP INDEX IF EXISTS search_embeddings_entity_idx;
    DROP INDEX IF EXISTS search_embeddings_search_idx;
    DROP INDEX IF EXISTS search_embeddings_tasks_idx;
    DROP INDEX IF EXISTS search_embeddings_alerts_idx;
    CREATE INDEX search_embeddings_entity_idx
      ON search_embeddings(entity_type, entity_id, provider, model);
    CREATE INDEX search_embeddings_search_idx
      ON search_embeddings(
        provider,
        model,
        source_sort_at DESC,
        entity_type,
        entity_id
      );
    CREATE INDEX search_embeddings_tasks_idx
      ON search_embeddings(provider, model, source_sort_at DESC, entity_id)
      WHERE entity_type = 'task';
    CREATE INDEX search_embeddings_alerts_idx
      ON search_embeddings(provider, model, source_sort_at DESC, entity_id)
      WHERE entity_type = 'alert';
    DROP TRIGGER IF EXISTS search_embeddings_update_task;
    DROP TRIGGER IF EXISTS search_embeddings_touch_task;
    DROP TRIGGER IF EXISTS search_embeddings_update_notification;
    DROP TRIGGER IF EXISTS search_embeddings_touch_notification;
    CREATE TRIGGER IF NOT EXISTS search_embeddings_delete_task
      AFTER DELETE ON tasks
      BEGIN
        DELETE FROM search_embeddings
        WHERE entity_type = 'task' AND entity_id = OLD.id;
      END;
    CREATE TRIGGER IF NOT EXISTS search_embeddings_update_task
      AFTER UPDATE OF title, description ON tasks
      BEGIN
        UPDATE search_embeddings
        SET source_sort_at = NULL
        WHERE entity_type = 'task' AND entity_id = NEW.id;
      END;
    CREATE TRIGGER IF NOT EXISTS search_embeddings_touch_task
      AFTER UPDATE OF updated_at ON tasks
      WHEN NEW.title = OLD.title
        AND COALESCE(NEW.description, '') = COALESCE(OLD.description, '')
      BEGIN
        UPDATE search_embeddings
        SET source_sort_at = NEW.updated_at
        WHERE entity_type = 'task' AND entity_id = NEW.id;
      END;
    CREATE TRIGGER IF NOT EXISTS search_embeddings_delete_notification
      AFTER DELETE ON notifications
      BEGIN
        DELETE FROM search_embeddings
        WHERE entity_type = 'alert' AND entity_id = OLD.id;
      END;
    CREATE TRIGGER IF NOT EXISTS search_embeddings_update_notification
      AFTER UPDATE OF title, body ON notifications
      BEGIN
        UPDATE search_embeddings
        SET source_sort_at = NULL
        WHERE entity_type = 'alert' AND entity_id = NEW.id;
      END;
    CREATE TRIGGER IF NOT EXISTS search_embeddings_touch_notification
      AFTER UPDATE OF received_at ON notifications
      WHEN NEW.title = OLD.title
        AND COALESCE(NEW.body, '') = COALESCE(OLD.body, '')
      BEGIN
        UPDATE search_embeddings
        SET source_sort_at = NEW.received_at
        WHERE entity_type = 'alert' AND entity_id = NEW.id;
      END;
    DELETE FROM search_embeddings
    WHERE (entity_type = 'task' AND NOT EXISTS (
      SELECT 1 FROM tasks WHERE tasks.id = search_embeddings.entity_id
    )) OR (entity_type = 'alert' AND NOT EXISTS (
      SELECT 1 FROM notifications WHERE notifications.id = search_embeddings.entity_id
    ));
    UPDATE search_embeddings
    SET source_sort_at = NULL
    WHERE entity_type = 'task' AND EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = search_embeddings.entity_id
        AND search_embeddings.updated_at < tasks.updated_at
    );
    UPDATE search_embeddings
    SET source_sort_at = CASE entity_type
      WHEN 'task' THEN (
        SELECT updated_at FROM tasks WHERE tasks.id = search_embeddings.entity_id
      )
      ELSE (
        SELECT received_at FROM notifications
        WHERE notifications.id = search_embeddings.entity_id
      )
    END
    WHERE source_sort_at IS NULL
      AND (
        entity_type = 'alert'
        OR EXISTS (
          SELECT 1 FROM tasks
          WHERE tasks.id = search_embeddings.entity_id
            AND search_embeddings.updated_at >= tasks.updated_at
        )
      );
  `);
  if (sourceSortAdded) {
    // Existing notification rows cannot prove that their text still matches.
    sqlite.prepare("DELETE FROM search_embeddings WHERE entity_type = 'alert'").run();
  }

  embeddingsTableReady = true;
}

function getEntityEmbeddingId(
  type: EmbeddingEntityType,
  id: string,
  provider: string,
  model: string,
) {
  return JSON.stringify([type, id, provider, model]);
}

export function buildTaskEmbeddingText(task: Pick<SearchableTaskRecord, 'title' | 'description'>) {
  return [task.title, truncate(task.description, 200)].filter(Boolean).join('\n');
}

export function buildNotificationEmbeddingText(notification: Pick<SearchableNotificationRecord, 'title' | 'body'>) {
  return [notification.title, truncate(notification.body, 200)].filter(Boolean).join('\n');
}

interface EmbeddingSourceSnapshot {
  title: string;
  body: string | null;
  sortAt: string;
}

function readEmbeddingSource(
  type: EmbeddingEntityType,
  id: string,
): EmbeddingSourceSnapshot | undefined {
  if (type === 'task') {
    return sqlite.prepare(`
      SELECT title, description AS body, updated_at AS sortAt
      FROM tasks WHERE id = ?
    `).get(id) as EmbeddingSourceSnapshot | undefined;
  }
  return sqlite.prepare(`
    SELECT title, body, received_at AS sortAt
    FROM notifications WHERE id = ?
  `).get(id) as EmbeddingSourceSnapshot | undefined;
}

function sourceMatches(
  expected: EmbeddingSourceSnapshot,
  current: EmbeddingSourceSnapshot | undefined,
) {
  return current !== undefined
    && current.title === expected.title
    && (current.body ?? '') === (expected.body ?? '')
    && current.sortAt === expected.sortAt;
}

/** @deprecated Use buildNotificationEmbeddingText */
export const buildAlertEmbeddingText = buildNotificationEmbeddingText;

export async function generateEmbedding(
  text: string,
  options: { sources?: string[] } = {},
): Promise<number[]> {
  const config = await getEmbeddingConfig(options.sources);
  if (!config) {
    return [];
  }
  return (await requestEmbedding(text, config))?.embedding ?? [];
}

interface GeneratedEmbedding {
  embedding: number[];
  provider: string;
  model: string;
}

interface EmbeddingRoute {
  provider: string;
  model: string;
}

function getConfiguredEmbeddingRoute(config: EmbeddingConfig): EmbeddingRoute {
  const outcome = getAIRouteOutcome(config.context, {
    modelId: config.model,
  });
  return {
    provider: outcome.provider,
    model: outcome.model,
  };
}

function getEmbeddingSeedSignature(
  config: Pick<EmbeddingConfig, 'provider' | 'model'>,
  route: EmbeddingRoute,
) {
  return `${config.provider}\0${config.model}\0${route.provider}\0${route.model}`;
}

function isEmbeddingRouteChangeError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(isEmbeddingRouteChangeError);
  }
  return error instanceof Error
    && error.message === 'Embedding route changed during rebuild';
}

function deferRouteRetry() {
  routeRetryFailures += 1;
  const delay = Math.min(
    ROUTE_RETRY_BASE_MS * (2 ** (routeRetryFailures - 1)),
    ROUTE_RETRY_MAX_MS,
  );
  routeRetryAfter = Date.now() + delay;
}

function clearRouteRetry() {
  routeRetryFailures = 0;
  routeRetryAfter = 0;
}

async function requestEmbedding(
  text: string,
  config: EmbeddingConfig,
): Promise<GeneratedEmbedding | null> {
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify(
        config.provider === 'azure'
          ? { input: text }
          : { model: config.model, input: text },
      ),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      aiLogger.warn({
        featureId: config.context.featureId,
        sensitivity: config.context.sensitivity,
        correlationId: config.context.correlationId,
        status: response.status,
      }, 'AI embedding request failed');
      return null;
    }

    const outcome = getAIRouteOutcome(config.context, {
      modelId: config.model,
      headers: Object.fromEntries(response.headers.entries()),
    });
    aiLogger.info({
      featureId: config.context.featureId,
      sensitivity: config.context.sensitivity,
      allowedRoutes: config.context.allowedRoutes,
      correlationId: config.context.correlationId,
      provider: outcome.provider,
      model: outcome.model,
      fallbackOccurred: outcome.fallbackOccurred,
      status: response.status,
    }, 'AI embedding request completed');

    const payload = await response.json() as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = payload.data?.[0]?.embedding;

    if (!embedding || !Array.isArray(embedding)) {
      return null;
    }

    return {
      embedding,
      provider: outcome.provider,
      model: outcome.model,
    };
  } catch (error) {
    if (error instanceof AIRoutingDeniedError) {
      throw error;
    }
    aiLogger.warn({ err: error }, 'AI embedding request failed');
    return null;
  }
}

export async function indexEntityEmbedding(
  type: EmbeddingEntityType,
  id: string,
  text: string,
  sources: string[] = [],
  source?: EmbeddingSourceSnapshot,
) {
  await ensureEmbeddingsTable();
  if (rebuildBarrier) await rebuildBarrier;

  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const sourceSnapshot = source ?? readEmbeddingSource(type, id);
  if (!sourceSnapshot) return false;

  const config = await getEmbeddingConfig(sources);
  if (!config) {
    return false;
  }

  const generated = await requestEmbedding(trimmed, config);
  if (!generated) {
    return false;
  }
  if (!sourceMatches(sourceSnapshot, readEmbeddingSource(type, id))) {
    return false;
  }
  const embeddingId = getEntityEmbeddingId(
    type,
    id,
    generated.provider,
    generated.model,
  );
  sqlite
    .prepare(`
      INSERT INTO search_embeddings (
        id, entity_type, entity_id, embedding, updated_at, provider, model,
        source_sort_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        embedding = excluded.embedding,
        updated_at = excluded.updated_at,
        provider = excluded.provider,
        model = excluded.model,
        source_sort_at = excluded.source_sort_at
    `)
    .run(
      embeddingId,
      type,
      id,
      JSON.stringify(generated.embedding),
      new Date().toISOString(),
      generated.provider,
      generated.model,
      sourceSnapshot.sortAt,
    );
  sqlite.prepare(`
    DELETE FROM search_embeddings
    WHERE entity_type = ?
      AND entity_id = ?
      AND provider = ?
      AND model = ?
      AND id <> ?
  `).run(type, id, generated.provider, generated.model, embeddingId);
  embeddingCache.delete(embeddingId);
  return true;
}

async function maybeSeedEmbeddings() {
  await ensureEmbeddingsTable();

  const config = await getEmbeddingConfig();
  if (!config) {
    return;
  }
  const route = getConfiguredEmbeddingRoute(config);
  const signature = getEmbeddingSeedSignature(config, route);
  if (embeddingsSeedSignature === signature) return;

  const [{ count: compatibleIndexedCount }] = sqlite
    .prepare(`
      SELECT COUNT(*) AS count
      FROM search_embeddings
      WHERE provider = ? AND model = ?
    `)
    .all(route.provider, route.model) as Array<{ count: number }>;
  const [{ count: taskCount }] = sqlite
    .prepare('SELECT COUNT(*) AS count FROM tasks')
    .all() as Array<{ count: number }>;
  const [{ count: notificationCount }] = sqlite
    .prepare('SELECT COUNT(*) AS count FROM notifications')
    .all() as Array<{ count: number }>;

  if (compatibleIndexedCount < taskCount + notificationCount) {
    if (routeRetryAfter > Date.now()) {
      return;
    }
    try {
      await rebuildEmbeddingIndex();
      clearRouteRetry();
    } catch (error) {
      if (isEmbeddingRouteChangeError(error)) {
        deferRouteRetry();
      }
      aiLogger.warn({ err: error }, 'Embedding index seed failed; retaining last-good rows');
      return;
    }
  }

  embeddingsSeedSignature = signature;
}

export async function rebuildEmbeddingIndex() {
  if (!rebuildPromise) {
    let releaseBarrier!: () => void;
    rebuildBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    rebuildPromise = performEmbeddingIndexRebuild().finally(() => {
      releaseBarrier();
      rebuildBarrier = null;
      rebuildPromise = null;
    });
  }
  return rebuildPromise;
}

async function stageEntityEmbedding(
  type: EmbeddingEntityType,
  id: string,
  text: string,
  sources: string[],
  sourceTitle: string,
  sourceBody: string | null,
  sourceSortAt: string,
  rebuildConfig: Pick<EmbeddingConfig, 'provider' | 'model'>,
  rebuildRoute: { current: EmbeddingRoute | null },
): Promise<boolean> {
  const config = await getEmbeddingConfig(sources);
  if (
    !config
    || config.provider !== rebuildConfig.provider
    || config.model !== rebuildConfig.model
  ) {
    throw new Error('Embedding provider configuration changed during rebuild');
  }
  const generated = await requestEmbedding(text, config);
  if (!generated) return false;
  if (!rebuildRoute.current) {
    rebuildRoute.current = {
      provider: generated.provider,
      model: generated.model,
    };
  } else if (
    generated.provider !== rebuildRoute.current.provider
    || generated.model !== rebuildRoute.current.model
  ) {
    throw new Error('Embedding route changed during rebuild');
  }

  sqlite.prepare(`
    INSERT INTO search_embeddings_rebuild (
      id, entity_type, entity_id, embedding, updated_at, provider, model,
      source_title, source_body, source_sort_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    getEntityEmbeddingId(type, id, generated.provider, generated.model),
    type,
    id,
    JSON.stringify(generated.embedding),
    new Date().toISOString(),
    generated.provider,
    generated.model,
    sourceTitle,
    sourceBody ?? '',
    sourceSortAt,
  );
  return true;
}

async function performEmbeddingIndexRebuild() {
  await ensureEmbeddingsTable();

  const status = await getSemanticSearchStatus();
  if (!status.available) {
    return;
  }
  const config = await getEmbeddingConfig();
  if (!config) return;
  const configuredRoute = getConfiguredEmbeddingRoute(config);
  const rebuildRoute: { current: EmbeddingRoute | null } = { current: null };

  const BATCH_CONCURRENCY = 5;
  const PAGE_SIZE = 100;
  const requireSuccessfulBatch = (
    results: PromiseSettledResult<boolean>[],
  ) => {
    const failures = results.flatMap((result) => {
      if (result.status === 'rejected') return [result.reason];
      return result.value ? [] : [new Error('Embedding provider returned no vector')];
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Embedding index rebuild batch failed');
    }
  };
  sqlite.exec(`
    DROP TABLE IF EXISTS search_embeddings_rebuild;
    CREATE TEMP TABLE search_embeddings_rebuild (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_body TEXT NOT NULL,
      source_sort_at TEXT NOT NULL
    );
  `);

  try {
    let lastTaskId = '';
    for (;;) {
      const taskRows = sqlite.prepare(`
        SELECT
          id,
          title,
          description,
          connector_type AS connectorType,
          updated_at AS sortAt
        FROM tasks
        WHERE id > ?
        ORDER BY id
        LIMIT ?
      `).all(lastTaskId, PAGE_SIZE) as Array<{
        id: string;
        title: string;
        description: string | null;
        connectorType: string;
        sortAt: string;
      }>;
      for (let i = 0; i < taskRows.length; i += BATCH_CONCURRENCY) {
        const batch = taskRows.slice(i, i + BATCH_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((task) => {
            const text = buildTaskEmbeddingText(task);
            if (!text.trim()) return Promise.resolve(true);
            return stageEntityEmbedding(
              'task',
              task.id,
              text,
              [task.connectorType],
              task.title,
              task.description,
              task.sortAt,
              config,
              rebuildRoute,
            );
          }),
        );
        requireSuccessfulBatch(results);
      }
      if (taskRows.length < PAGE_SIZE) break;
      lastTaskId = taskRows[taskRows.length - 1].id;
    }

    let lastNotificationId = '';
    for (;;) {
      const notificationRows = sqlite.prepare(`
        SELECT
          id,
          title,
          body,
          connector_type AS connectorType,
          received_at AS sortAt
        FROM notifications
        WHERE id > ?
        ORDER BY id
        LIMIT ?
      `).all(lastNotificationId, PAGE_SIZE) as Array<{
        id: string;
        title: string;
        body: string | null;
        connectorType: string;
        sortAt: string;
      }>;
      for (let i = 0; i < notificationRows.length; i += BATCH_CONCURRENCY) {
        const batch = notificationRows.slice(i, i + BATCH_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((notification) => {
            const text = buildNotificationEmbeddingText(notification);
            if (!text.trim()) return Promise.resolve(true);
            return stageEntityEmbedding(
              'alert',
              notification.id,
              text,
              [notification.connectorType],
              notification.title,
              notification.body,
              notification.sortAt,
              config,
              rebuildRoute,
            );
          }),
        );
        requireSuccessfulBatch(results);
      }
      if (notificationRows.length < PAGE_SIZE) break;
      lastNotificationId = notificationRows[notificationRows.length - 1].id;
    }

    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const committedRoute = rebuildRoute.current ?? configuredRoute;
      sqlite.prepare(`
        DELETE FROM search_embeddings WHERE provider = ? AND model = ?
      `).run(committedRoute.provider, committedRoute.model);
      sqlite.prepare(`
        INSERT INTO search_embeddings (
          id, entity_type, entity_id, embedding, updated_at, provider, model,
          source_sort_at
        )
        SELECT
          id,
          entity_type,
          entity_id,
          embedding,
          updated_at,
          provider,
          model,
          source_sort_at
        FROM search_embeddings_rebuild
        WHERE (
          entity_type = 'task'
          AND EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.id = search_embeddings_rebuild.entity_id
              AND t.title = search_embeddings_rebuild.source_title
              AND COALESCE(t.description, '') = search_embeddings_rebuild.source_body
              AND t.updated_at = search_embeddings_rebuild.source_sort_at
          )
        ) OR (
          entity_type = 'alert'
          AND EXISTS (
            SELECT 1 FROM notifications n
            WHERE n.id = search_embeddings_rebuild.entity_id
              AND n.title = search_embeddings_rebuild.source_title
              AND COALESCE(n.body, '') = search_embeddings_rebuild.source_body
              AND n.received_at = search_embeddings_rebuild.source_sort_at
          )
        )
      `).run();
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
    embeddingsSeedSignature = getEmbeddingSeedSignature(
      config,
      rebuildRoute.current ?? configuredRoute,
    );
  } finally {
    sqlite.exec('DROP TABLE IF EXISTS search_embeddings_rebuild');
  }
}

/** Ensure the current provider/model has an embedding index before searching. */
export async function warmUpEmbeddings() {
  await maybeSeedEmbeddings();
}

interface IndexedEmbeddingMetadata {
  id: string;
  entityType: EmbeddingEntityType;
  entityId: string;
  updatedAt: string;
  provider: string;
  model: string;
}

interface IndexedEmbeddingRow extends IndexedEmbeddingMetadata {
  embedding: string;
}

function parseEmbedding(value: string): Float32Array | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length === 0
      || parsed.some((component) => (
        typeof component !== 'number' || !Number.isFinite(component)
      ))
    ) {
      return null;
    }
    return Float32Array.from(parsed);
  } catch {
    return null;
  }
}

function cacheEmbedding(row: IndexedEmbeddingRow): EmbeddingCacheEntry | null {
  const embedding = parseEmbedding(row.embedding);
  if (!embedding) return null;
  const entry: EmbeddingCacheEntry = {
    ...row,
    embedding,
    norm: computeNorm(embedding),
  };
  embeddingCache.set(entry);
  return entry;
}

function getCachedEmbedding(row: IndexedEmbeddingRow): EmbeddingCacheEntry | null {
  return embeddingCache.get(
    row.id,
    row.updatedAt,
    row.provider,
    row.model,
  ) ?? cacheEmbedding(row);
}

function getCandidateMetadata(
  config: Pick<EmbeddingConfig, 'provider' | 'model'>,
  type: SearchScope,
): IndexedEmbeddingMetadata[] {
  const select = `
    SELECT
      e.id,
      e.entity_type AS entityType,
      e.entity_id AS entityId,
      e.updated_at AS updatedAt,
      e.provider,
      e.model
    FROM search_embeddings e
    WHERE e.provider = ?
      AND e.model = ?
      AND e.source_sort_at IS NOT NULL
  `;
  if (type === 'all') {
    return sqlite.prepare(`
      ${select}
      ORDER BY e.source_sort_at DESC, e.entity_type, e.entity_id
      LIMIT ?
    `).all(
      config.provider,
      config.model,
      SEARCH_MAX_CANDIDATES,
    ) as IndexedEmbeddingMetadata[];
  }

  const entityType = type === 'tasks' ? 'task' : 'alert';
  return sqlite.prepare(`
    ${select}
      AND e.entity_type = '${entityType}'
    ORDER BY e.source_sort_at DESC, e.entity_type, e.entity_id
    LIMIT ?
  `).all(
    config.provider,
    config.model,
    SEARCH_MAX_CANDIDATES,
  ) as IndexedEmbeddingMetadata[];
}

function scanCandidateEmbeddings(
  config: Pick<EmbeddingConfig, 'provider' | 'model'>,
  type: SearchScope,
  visit: (entry: EmbeddingCacheEntry) => void,
): number {
  const metadata = getCandidateMetadata(config, type);

  for (let offset = 0; offset < metadata.length; offset += CANDIDATE_PAGE_SIZE) {
    const page = metadata.slice(offset, offset + CANDIDATE_PAGE_SIZE);
    const loaded = new Map<string, EmbeddingCacheEntry>();
    const missingIds: string[] = [];

    for (const candidate of page) {
      const cached = embeddingCache.get(
        candidate.id,
        candidate.updatedAt,
        candidate.provider,
        candidate.model,
      );
      if (cached) {
        loaded.set(candidate.id, cached);
      } else {
        missingIds.push(candidate.id);
      }
    }

    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const rows = sqlite.prepare(`
        SELECT
          id,
          entity_type AS entityType,
          entity_id AS entityId,
          embedding,
          updated_at AS updatedAt,
          provider,
          model
        FROM search_embeddings
        WHERE id IN (${placeholders})
      `).all(...missingIds) as IndexedEmbeddingRow[];
      for (const row of rows) {
        const entry = cacheEmbedding(row);
        if (entry) loaded.set(entry.id, entry);
      }
    }

    for (const candidate of page) {
      const entry = loaded.get(candidate.id);
      if (
        entry
        && entry.updatedAt === candidate.updatedAt
        && entry.provider === candidate.provider
        && entry.model === candidate.model
      ) {
        visit(entry);
      }
    }
  }

  return metadata.length;
}

function recordSearchMetrics(candidates: number, durationMs: number) {
  searchMetrics.searches++;
  searchMetrics.totalCandidates += candidates;
  searchMetrics.lastCandidates = candidates;
  if (candidates === SEARCH_MAX_CANDIDATES) {
    searchMetrics.saturatedSearches++;
  }
  searchMetrics.durationsMs.push(durationMs);
  if (searchMetrics.durationsMs.length > 128) {
    searchMetrics.durationsMs.shift();
  }
}

export function getSemanticSearchMetrics() {
  const sortedDurations = [...searchMetrics.durationsMs].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
  return {
    cache: embeddingCache.getMetrics(),
    search: {
      searches: searchMetrics.searches,
      totalCandidates: searchMetrics.totalCandidates,
      lastCandidates: searchMetrics.lastCandidates,
      candidateLimit: SEARCH_MAX_CANDIDATES,
      saturatedSearches: searchMetrics.saturatedSearches,
      p95DurationMs: sortedDurations[p95Index] ?? 0,
    },
    rebuild: {
      inProgress: rebuildPromise !== null,
    },
  };
}

export interface TaskEmbeddingNeighbor {
  taskId: string;
  score: number;
  embeddingUpdatedAt: string;
}

export type TaskEmbeddingNeighborResult =
  | {
      status: 'available';
      provider: string;
      model: string;
      sourceUpdatedAt: string;
      neighbors: TaskEmbeddingNeighbor[];
    }
  | {
      status: 'unavailable' | 'missing' | 'stale' | 'incompatible';
      note: string;
      neighbors: [];
    };

export async function findSimilarTaskEmbeddings(
  taskId: string,
  options: { limit?: number; minScore?: number } = {},
): Promise<TaskEmbeddingNeighborResult> {
  const startedAt = performance.now();
  await ensureEmbeddingsTable();
  const config = await getEmbeddingConfig();
  if (!config) {
    return {
      status: 'unavailable',
      note: 'Semantic neighbors require a configured embedding provider.',
      neighbors: [],
    };
  }
  const sourceRow = sqlite.prepare(`
    SELECT
      id,
      entity_type AS entityType,
      entity_id AS entityId,
      embedding,
      updated_at AS updatedAt,
      provider,
      model
    FROM search_embeddings
    WHERE entity_type = 'task'
      AND entity_id = ?
      AND provider = ?
      AND model = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(taskId, config.provider, config.model) as IndexedEmbeddingRow | undefined;
  if (!sourceRow) {
    const incompatible = sqlite.prepare(`
      SELECT 1
      FROM search_embeddings
      WHERE entity_type = 'task' AND entity_id = ?
      LIMIT 1
    `).get(taskId);
    return {
      status: incompatible ? 'incompatible' : 'missing',
      note: incompatible
        ? 'The selected task embedding was produced by a different embedding model.'
        : 'The selected task does not have an indexed embedding.',
      neighbors: [],
    };
  }
  const source = getCachedEmbedding(sourceRow);
  if (!source) {
    return {
      status: 'missing',
      note: 'The selected task does not have a valid indexed embedding.',
      neighbors: [],
    };
  }
  const sourceTask = sqlite.prepare(
    'SELECT updated_at AS updatedAt FROM tasks WHERE id = ?',
  ).get(taskId) as { updatedAt: string } | undefined;
  if (!sourceTask) {
    return {
      status: 'missing',
      note: 'The selected task no longer exists.',
      neighbors: [],
    };
  }
  if (source.updatedAt < sourceTask.updatedAt) {
    return {
      status: 'stale',
      note: 'The selected task embedding is older than the task.',
      neighbors: [],
    };
  }

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 25);
  const minScore = Math.min(Math.max(options.minScore ?? SIMILARITY_THRESHOLD, 0), 1);
  const ranked: Array<{ candidate: EmbeddingCacheEntry; score: number }> = [];
  const candidates = scanCandidateEmbeddings(config, 'tasks', (candidate) => {
    if (
      candidate.entityId === taskId
      || candidate.embedding.length !== source.embedding.length
    ) {
      return;
    }
    const score = cosineSimilarityWithNorm(
      source.embedding,
      candidate.embedding,
      candidate.norm,
    );
    if (score < minScore) return;
    const insertAt = ranked.findIndex((rankedCandidate) => (
      score > rankedCandidate.score
    ));
    if (insertAt === -1) ranked.push({ candidate, score });
    else ranked.splice(insertAt, 0, { candidate, score });
    if (ranked.length > limit) ranked.pop();
  });
  recordSearchMetrics(candidates, performance.now() - startedAt);

  if (!ranked.length) {
    return {
      status: 'available',
      provider: config.provider,
      model: config.model,
      sourceUpdatedAt: source.updatedAt,
      neighbors: [],
    };
  }
  const neighbors = ranked.map(({ candidate, score }) => ({
    taskId: candidate.entityId,
    score: Math.min(score, 1),
    embeddingUpdatedAt: candidate.updatedAt,
  }));
  return {
    status: 'available',
    provider: config.provider,
    model: config.model,
    sourceUpdatedAt: source.updatedAt,
    neighbors,
  };
}


export async function semanticSearch(
  query: string,
  options: { type?: SearchScope; limit?: number } = {},
): Promise<SearchResult[]> {
  const startedAt = performance.now();
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const config = await getEmbeddingConfig();
  if (!config) {
    return [];
  }

  await maybeSeedEmbeddings();

  const generatedQuery = await requestEmbedding(normalizedQuery, config);
  if (!generatedQuery) {
    return [];
  }
  const queryEmbedding = generatedQuery.embedding;

  const type = options.type ?? 'all';
  const limit = normalizeLimit(options.limit);

  const topCandidates: Array<{ cached: EmbeddingCacheEntry; score: number }> = [];
  const candidates = scanCandidateEmbeddings(generatedQuery, type, (cached) => {
    if (cached.embedding.length !== queryEmbedding.length) return;

    const score = cosineSimilarityWithNorm(queryEmbedding, cached.embedding, cached.norm);
    if (score < SIMILARITY_THRESHOLD) return;
    const insertAt = topCandidates.findIndex((candidate) => score > candidate.score);
    if (insertAt === -1) topCandidates.push({ cached, score });
    else topCandidates.splice(insertAt, 0, { cached, score });
    if (topCandidates.length > limit) topCandidates.pop();
  });
  recordSearchMetrics(candidates, performance.now() - startedAt);

  if (topCandidates.length === 0) {
    return [];
  }

  // Batch-load metadata for top results
  const taskIds = topCandidates
    .filter((c) => c.cached.entityType === 'task')
    .map((c) => c.cached.entityId);
  const notificationIds = topCandidates
    .filter((c) => c.cached.entityType === 'alert')
    .map((c) => c.cached.entityId);

  const taskMap = new Map<string, { title: string; description: string | null; status: string; priority: string; sourceListName: string | null; connectorType: string; updatedAt: string }>();
  const notificationMap = new Map<string, { title: string; body: string | null; severity: string; category: string; isRead: number; isActionable: number; connectorType: string; receivedAt: string }>();

  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = sqlite
      .prepare(`SELECT id, title, description, status, priority, source_list_name AS sourceListName, connector_type AS connectorType, updated_at AS updatedAt FROM tasks WHERE id IN (${placeholders})`)
      .all(...taskIds) as Array<{ id: string; title: string; description: string | null; status: string; priority: string; sourceListName: string | null; connectorType: string; updatedAt: string }>;
    for (const row of rows) {
      taskMap.set(row.id, row);
    }
  }

  if (notificationIds.length > 0) {
    const placeholders = notificationIds.map(() => '?').join(',');
    const rows = sqlite
      .prepare(`SELECT id, title, body, level AS severity, category, CASE WHEN read_state = 'read' THEN 1 ELSE 0 END AS isRead, 1 AS isActionable, connector_type AS connectorType, received_at AS receivedAt FROM notifications WHERE id IN (${placeholders})`)
      .all(...notificationIds) as Array<{ id: string; title: string; body: string | null; severity: string; category: string; isRead: number; isActionable: number; connectorType: string; receivedAt: string }>;
    for (const row of rows) {
      notificationMap.set(row.id, row);
    }
  }

  const results: SearchResult[] = [];

  for (const { cached, score } of topCandidates) {
    if (cached.entityType === 'task') {
      const row = taskMap.get(cached.entityId);
      if (!row) continue;
      results.push({
        type: 'task',
        id: cached.entityId,
        title: row.title,
        snippet: truncate(row.description),
        score,
        source: 'semantic',
        href: buildTaskHref(cached.entityId),
        metadata: {
          status: row.status,
          priority: row.priority,
          sourceListName: row.sourceListName,
          connectorType: row.connectorType,
          updatedAt: row.updatedAt,
        },
      });
    } else {
      const row = notificationMap.get(cached.entityId);
      if (!row) continue;
      results.push({
        type: 'notification',
        id: cached.entityId,
        title: row.title,
        snippet: truncate(row.body ?? row.category),
        score,
        source: 'semantic',
        href: buildNotificationHref(cached.entityId),
        metadata: {
          severity: row.severity,
          category: row.category,
          isRead: Boolean(row.isRead),
          isActionable: Boolean(row.isActionable),
          connectorType: row.connectorType,
          receivedAt: row.receivedAt,
        },
      });
    }
  }

  return results;
}
