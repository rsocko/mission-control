import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  SemanticIndexRepository,
  SemanticSensitivity,
} from '@/lib/semantic-index/contracts';
import { SqliteSemanticIndexRepository } from '@/lib/semantic-index/sqlite-repository';
import type {
  SemanticEmbeddingOutcome,
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
  SemanticRouteResolution,
} from '@/lib/semantic-index/embedding-provider';
import type {
  SemanticAlertSource,
  SemanticProjectSource,
  SemanticSourceEntityType,
  SemanticSourceIdPage,
  SemanticSourcePort,
  SemanticSourceRecord,
  SemanticSourceRecordPage,
  SemanticTaskSource,
  SemanticTagSource,
  SemanticTriageItemSource,
} from '@/lib/semantic-index/source/contracts';
import { SemanticIndexService } from '@/lib/semantic-index/service';
import { getSemanticWorkerConfig, type SemanticWorkerConfig } from '@/lib/semantic-index/config';

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'drizzle', '0121_semantic_index.sql'),
  'utf8',
);

export function createSemanticTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const statement of MIGRATION.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement);
  }
  return db;
}

// ─── In-memory source port ──────────────────────────────────────────────────

/**
 * A source port backed by plain maps. It has the same ordering and pagination
 * semantics as the SQLite/PostgreSQL adapters (ascending id, exclusive cursor),
 * so run resumption logic is exercised for real.
 */
export class FakeSemanticSourcePort implements SemanticSourcePort {
  readonly tasks = new Map<string, SemanticTaskSource>();
  readonly projects = new Map<string, SemanticProjectSource>();
  readonly tags = new Map<string, SemanticTagSource>();
  readonly triageItems = new Map<string, SemanticTriageItemSource>();
  readonly alerts = new Map<string, SemanticAlertSource>();
  listIdsCalls = 0;
  /** Simulated per-page latency, used to make slice deadlines deterministic. */
  pageDelayMs = 0;

  putTask(task: SemanticTaskSource): void {
    this.tasks.set(task.id, task);
  }

  putAlert(alert: SemanticAlertSource): void {
    this.alerts.set(alert.id, alert);
  }

  putProject(project: SemanticProjectSource): void {
    this.projects.set(project.id, project);
  }

  putTag(tag: SemanticTagSource): void {
    this.tags.set(tag.id, tag);
  }

  putTriageItem(item: SemanticTriageItemSource): void {
    this.triageItems.set(item.id, item);
  }

  private bucket(entityType: SemanticSourceEntityType): Map<string, SemanticSourceRecord> {
    switch (entityType) {
      case 'task': return this.tasks as Map<string, SemanticSourceRecord>;
      case 'project': return this.projects as Map<string, SemanticSourceRecord>;
      case 'tag': return this.tags as Map<string, SemanticSourceRecord>;
      case 'triage-item': return this.triageItems as Map<string, SemanticSourceRecord>;
      case 'alert': return this.alerts as Map<string, SemanticSourceRecord>;
    }
  }

  async get(
    entityType: SemanticSourceEntityType,
    entityId: string,
  ): Promise<SemanticSourceRecord | null> {
    return this.bucket(entityType).get(entityId) ?? null;
  }

  async listIds(
    entityType: SemanticSourceEntityType,
    input: { afterId?: string | null; limit: number },
  ): Promise<SemanticSourceIdPage> {
    this.listIdsCalls += 1;
    if (this.pageDelayMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, this.pageDelayMs); });
    }
    const after = input.afterId ?? '';
    const ids = [...this.bucket(entityType).keys()]
      .filter((id) => id > after)
      .sort()
      .slice(0, input.limit);
    return {
      ids,
      nextCursor: ids.length === input.limit ? ids[ids.length - 1] : null,
    };
  }

  async list(
    entityType: SemanticSourceEntityType,
    input: { afterId?: string | null; limit: number },
  ): Promise<SemanticSourceRecordPage> {
    const bucket = this.bucket(entityType);
    const page = await this.listIds(entityType, input);
    return {
      records: page.ids.map((id) => bucket.get(id)!),
      nextCursor: page.nextCursor,
    };
  }

  async listExisting(
    entityType: SemanticSourceEntityType,
    entityIds: string[],
  ): Promise<Set<string>> {
    const bucket = this.bucket(entityType);
    return new Set(entityIds.filter((id) => bucket.has(id)));
  }
}

// ─── Scripted embedding provider ────────────────────────────────────────────

export interface FakeEmbeddingProviderOptions {
  dimensions?: number;
  provider?: string;
  model?: string;
  route?: SemanticRouteResolution;
}

/**
 * Deterministic embedding provider. Each call returns a unit vector derived
 * from the request text, so identical text yields an identical vector — which
 * is exactly what the fingerprint-skip assertions need.
 */
export class FakeEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly calls: SemanticEmbeddingRequest[] = [];
  private readonly queue: SemanticEmbeddingOutcome[] = [];
  readonly dimensions: number;
  /** Mutable so a test can simulate an operator changing the embedding route. */
  provider: string;
  model: string;
  private readonly routeResolution: SemanticRouteResolution | null;

  constructor(options: FakeEmbeddingProviderOptions = {}) {
    this.dimensions = options.dimensions ?? 3;
    this.provider = options.provider ?? 'openai';
    this.model = options.model ?? 'text-embedding-3-small';
    this.routeResolution = options.route ?? null;
  }

  enqueue(outcome: SemanticEmbeddingOutcome): void {
    this.queue.push(outcome);
  }

  async resolveRoute(): Promise<SemanticRouteResolution> {
    return this.routeResolution
      ?? { status: 'ok', route: { provider: this.provider, model: this.model } };
  }

  async embed(request: SemanticEmbeddingRequest): Promise<SemanticEmbeddingOutcome> {
    this.calls.push(request);
    const scripted = this.queue.shift();
    if (scripted) return scripted;

    const embedding = new Float32Array(this.dimensions);
    for (let index = 0; index < this.dimensions; index++) {
      let hash = index + 1;
      for (let position = 0; position < request.text.length; position++) {
        hash = (hash * 31 + request.text.charCodeAt(position)) % 9973;
      }
      embedding[index] = (hash % 100) / 100 + 0.01;
    }
    return {
      status: 'ok',
      embedding,
      provider: this.provider,
      model: this.model,
      dimensions: this.dimensions,
    };
  }
}

// ─── Harness ────────────────────────────────────────────────────────────────

export interface SemanticHarnessOptions {
  sensitivity?: SemanticSensitivity | ((connectorType: string) => SemanticSensitivity);
  embeddings?: FakeEmbeddingProvider;
  config?: Partial<SemanticWorkerConfig>;
  now?: () => string;
}

export interface SemanticHarness {
  db: Database.Database;
  repository: SemanticIndexRepository;
  source: FakeSemanticSourcePort;
  embeddings: FakeEmbeddingProvider;
  service: SemanticIndexService;
  config: SemanticWorkerConfig;
  ids: () => string;
  close(): void;
}

export function createSemanticHarness(options: SemanticHarnessOptions = {}): SemanticHarness {
  const db = createSemanticTestDatabase();
  const repository = new SqliteSemanticIndexRepository(db, 100);
  const source = new FakeSemanticSourcePort();
  const embeddings = options.embeddings ?? new FakeEmbeddingProvider();

  let sequence = 0;
  const newId = () => `id-${++sequence}`;

  const resolveSensitivity = ({ connectorType }: { connectorType: string }) => {
    if (typeof options.sensitivity === 'function') return options.sensitivity(connectorType);
    return options.sensitivity ?? 'standard';
  };

  const service = new SemanticIndexService({
    repository,
    source,
    embeddings,
    resolveSensitivity,
    now: options.now,
    newId,
  });

  return {
    db,
    repository,
    source,
    embeddings,
    service,
    config: { ...getSemanticWorkerConfig(), ...options.config },
    ids: newId,
    close: () => db.close(),
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

export function taskFixture(overrides: Partial<SemanticTaskSource> = {}): SemanticTaskSource {
  return {
    entityType: 'task',
    semanticEligible: true,
    id: 'task-1',
    title: 'Ship the semantic index',
    description: 'Persist versioned documents and vectors.',
    status: 'todo',
    statusReason: null,
    microStatus: null,
    priority: 'medium',
    planningHorizon: null,
    localDisposition: 'active',
    effort: null,
    dueDate: null,
    connectorType: 'github-issues',
    sourceListName: null,
    parentId: null,
    isChecklistItem: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    completedAt: null,
    tags: [],
    projects: [],
    ...overrides,
  };
}

export function alertFixture(overrides: Partial<SemanticAlertSource> = {}): SemanticAlertSource {
  return {
    entityType: 'alert',
    semanticEligible: true,
    id: 'alert-1',
    title: 'Sync failed',
    body: 'Upstream API unreachable.',
    level: 'critical',
    category: 'sync',
    state: 'unread',
    readState: 'unread',
    disposition: 'inbox',
    sourceState: 'active',
    connectorType: 'microsoft-todo',
    isActionable: false,
    receivedAt: '2026-08-20T00:00:00.000Z',
    sortAt: '2026-08-20T00:00:00.000Z',
    expiresAt: null,
    lastSourceActivityAt: null,
    readAt: null,
    handledAt: null,
    resolvedAt: null,
    archivedAt: null,
    dismissedAt: null,
    relatedTaskId: null,
    relatedProjectId: null,
    ...overrides,
  };
}

export function projectFixture(
  overrides: Partial<SemanticProjectSource> = {},
): SemanticProjectSource {
  return {
    entityType: 'project',
    semanticEligible: true,
    id: 'project-1',
    name: 'Semantic platform',
    description: 'Deliver durable semantic retrieval.',
    status: 'active',
    statusOverride: null,
    hidden: false,
    category: 'engineering',
    targetDate: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    tags: ['platform'],
    representativeTasks: ['Build projections'],
    representativeTaskConnectorTypes: ['github-issues'],
    taskCount: 1,
    latestTaskUpdatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

export function tagFixture(overrides: Partial<SemanticTagSource> = {}): SemanticTagSource {
  return {
    entityType: 'tag',
    semanticEligible: true,
    id: 'tag-1',
    name: 'Semantic search',
    slug: 'semantic-search',
    type: 'hub',
    source: null,
    confirmed: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    unifiedInto: null,
    usageCount: 2,
    representativeTasks: ['Build projections', 'Test retrieval'],
    representativeTaskConnectorTypes: ['github-issues', 'local'],
    latestTaskUpdatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

export function triageItemFixture(
  overrides: Partial<SemanticTriageItemSource> = {},
): SemanticTriageItemSource {
  return {
    entityType: 'triage-item',
    semanticEligible: true,
    id: 'triage-1',
    sourcePlatform: 'github',
    title: 'Vector database research',
    description: 'Compare bounded local vector indexes.',
    contentType: 'repo',
    capturedAt: '2026-08-01T00:00:00.000Z',
    ingestedAt: '2026-08-20T00:00:00.000Z',
    status: 'pending',
    snoozedUntil: null,
    aiSummary: 'Candidate libraries for local semantic search.',
    aiCategories: ['software-development'],
    aiRelevanceScore: 87,
    aiUrgency: 'evergreen',
    ...overrides,
  };
}
