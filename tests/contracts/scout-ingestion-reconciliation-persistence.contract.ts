import { describe, expect, it } from 'vitest';
import type {
  ScoutConnectorBootstrapResult,
  ScoutCrossConnectorCandidate,
  ScoutEvaluationContext,
  ScoutExistingTask,
  ScoutIngestionReconciliationPersistence,
  ScoutIngestionRepository,
  ScoutLinkSourceInput,
  ScoutSourceListDefinition,
  ScoutTaskCreationInput,
  ScoutTaskMergeDecision,
  ScoutTriageUpsertInput,
} from '@/db/persistence/scout-ingestion-reconciliation';
import type { TaskFieldStateRecord } from '@/lib/tasks/field-state';
import type { TriageActionRecord, TriageItem } from '@/types';
import type {
  DocumentActionTaskRepository,
  TriageActionRepository,
} from '@/db/persistence/triage-repositories';

export const SCOUT_NOW = '2026-09-08T12:00:00.000Z';
const CONNECTOR_INSTANCE_ID = 'scout-primary';

export const TRIAGE_ACTION_NOW = '2026-09-08T12:00:00.000Z';

export interface TriageActionContractHarness {
  readonly actions: TriageActionRepository;
  readonly documentTaskActions: DocumentActionTaskRepository;
  reset(): Promise<void>;
  seedItem(item: TriageItem): Promise<void>;
  seedTask(input: {
    readonly id: string;
    readonly connectorType: string;
    readonly connectorInstanceId: string;
    readonly sourceId: string;
    readonly title: string;
    readonly status: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<void>;
  readItem(id: string): Promise<TriageItem | null>;
  countClaims(): Promise<number>;
}

export function triageItemFixture(overrides: Partial<TriageItem> = {}): TriageItem {
  return {
    id: 'triage-1',
    sourcePlatform: 'reddit',
    sourceId: 'reddit:1',
    sourceUrl: 'https://example.com/a',
    title: 'Saved article',
    contentType: 'article',
    capturedAt: TRIAGE_ACTION_NOW,
    ingestedAt: TRIAGE_ACTION_NOW,
    status: 'pending',
    aiCategories: [],
    aiSuggestedActions: [],
    aiRelevanceScore: 50,
    aiUrgency: 'evergreen',
    rawMetadata: {},
    actionsTaken: [],
    ...overrides,
  } as TriageItem;
}

function triageActionRecord(id: string, overrides: Partial<TriageActionRecord> = {}): TriageActionRecord {
  return {
    id,
    actionType: 'dismiss',
    appliedAt: TRIAGE_ACTION_NOW,
    ...overrides,
  } as TriageActionRecord;
}

export interface ScoutSeedTask {
  readonly id: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly title: string;
  readonly status: string;
  readonly priority?: string;
  readonly dueDate?: string | null;
  readonly createdAt?: string;
  readonly metadata?: Record<string, unknown>;
  readonly sourceListId?: string | null;
}

export interface ScoutSeedTriageItem {
  readonly id: string;
  readonly sourcePlatform: string;
  readonly sourceId: string;
  readonly title: string;
  readonly status: string;
}

export interface ScoutStoredTask {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly statusReason: string | null;
  readonly priority: string;
  readonly dueDate: string | null;
  readonly completedAt: string | null;
  readonly metadata: unknown;
}

export interface ScoutStoredSuggestion {
  readonly id: string;
  readonly taskId: string;
  readonly status: string;
  readonly evidenceHash: string;
}

export interface ScoutPersistenceContractHarness {
  readonly persistence: ScoutIngestionReconciliationPersistence;
  reset(): Promise<void>;
  seedConnector(input: {
    readonly id: string;
    readonly type: string;
    readonly enabled: boolean;
    readonly settings: unknown;
    readonly deletedAt?: string | null;
  }): Promise<void>;
  seedTask(task: ScoutSeedTask): Promise<void>;
  seedProject(id: string): Promise<void>;
  seedSuppression(input: {
    readonly connectorInstanceId: string;
    readonly sourceId: string;
  }): Promise<void>;
  seedTriageItem(item: ScoutSeedTriageItem): Promise<void>;
  seedTaskProject(input: {
    readonly taskId: string;
    readonly projectId: string;
  }): Promise<void>;
  readTask(id: string): Promise<ScoutStoredTask | null>;
  readFieldStates(taskId: string): Promise<
    { readonly fieldName: string; readonly sourceValue: string; readonly locallyOverridden: boolean }[]
  >;
  readSourceList(sourceId: string): Promise<
    { readonly name: string; readonly taskCount: number } | null
  >;
  readTriageItem(input: {
    readonly sourcePlatform: string;
    readonly sourceId: string;
  }): Promise<{ readonly id: string; readonly status: string; readonly title: string } | null>;
  countTaskTags(taskId: string): Promise<number>;
  countLinkedSources(): Promise<number>;
  countEvaluations(): Promise<number>;
  countNotifications(): Promise<number>;
  listSuggestions(): Promise<ScoutStoredSuggestion[]>;
  readRunStatus(runId: string): Promise<string | null>;
}

const SOURCE_LIST = {
  id: 'sl-scout-email',
  sourceId: 'scout:email-actions',
  name: 'Email Actions',
  type: 'folder',
  icon: 'mdi:email-outline',
  iconColor: '#0078d4',
} as const;

const CONNECTOR_DEFAULTS = {
  type: 'scout',
  name: 'Scout',
  syncMode: 'push',
  pollIntervalMinutes: null,
  capabilities: JSON.stringify({ read: true }),
  credentials: JSON.stringify({}),
  settings: JSON.stringify({ landingMode: 'direct' }),
  syncedLists: JSON.stringify([]),
} as const;

function evidence(hash: string) {
  return [{
    signalId: `signal-${hash}`,
    sourceType: 'planner',
    kind: 'planner-completed',
    occurredAt: SCOUT_NOW,
    summary: 'Planner item completed',
    sourceRefHash: hash,
  }];
}

// ─── Shared in-memory Scout ingestion fake ──────────────────────────────────
//
// A backend-neutral, fully in-memory implementation of ScoutIngestionRepository
// used by the route-level Scout ingest suites (scout-ingest, scout-e2e,
// scout-dedup-multirun) to observe writes without touching SQLite/Postgres.

export interface FakeTask extends ScoutExistingTask {
  sourceId: string;
  connectorType: string;
}

export class FakeScoutIngestion implements ScoutIngestionRepository {
  connector: ScoutConnectorBootstrapResult = {
    existed: true,
    enabled: true,
    settings: {
      landingMode: 'direct',
      allowedSourceTypes: ['email', 'teams', 'meeting', 'planner', 'cross-source'],
      hybridConfidenceThreshold: 0.8,
      autoProjectId: null,
    },
  };

  tasks = new Map<string, FakeTask>();
  /** Optional task the merge transaction observes instead of `tasks`. */
  mergeSnapshotOverride: ScoutExistingTask | null = null;
  fieldStates = new Map<string, TaskFieldStateRecord[]>();
  suppressions = new Set<string>();
  links = new Map<string, string>();
  triageItems = new Map<string, { id: string; status: string }>();
  projects = new Set<string>();
  sourceLists = new Set<string>();
  crossConnectorCandidates: ScoutCrossConnectorCandidate[] = [];
  /** When set, the next createTask reports a unique conflict with this winner. */
  conflictWinnerId: string | null = null;

  creations: ScoutTaskCreationInput[] = [];
  linkWrites: ScoutLinkSourceInput[] = [];
  triageWrites: ScoutTriageUpsertInput[] = [];
  mergeWrites: Extract<ScoutTaskMergeDecision, { kind: 'apply' }>[] = [];
  countRefreshes: { sourceListId: string }[] = [];
  createdSourceLists: string[] = [];

  async bootstrapConnector(): Promise<ScoutConnectorBootstrapResult> {
    return this.connector;
  }

  async ensureSourceList(input: {
    connectorInstanceId: string;
    definition: ScoutSourceListDefinition;
    now: string;
  }): Promise<{ created: boolean }> {
    if (this.sourceLists.has(input.definition.sourceId)) return { created: false };
    this.sourceLists.add(input.definition.sourceId);
    this.createdSourceLists.push(input.definition.sourceId);
    return { created: true };
  }

  async listCrossConnectorCandidates(): Promise<ScoutCrossConnectorCandidate[]> {
    return this.crossConnectorCandidates;
  }

  async findExistingTask(input: { connectorType: string; sourceId: string }) {
    for (const task of this.tasks.values()) {
      if (task.connectorType === input.connectorType && task.sourceId === input.sourceId) {
        return { ...task };
      }
    }
    return null;
  }

  async findTriageItem(input: { sourcePlatform: string; sourceId: string }) {
    return this.triageItems.get(input.sourceId) ?? null;
  }

  async filterExistingProjectIds(projectIds: readonly string[]) {
    return projectIds.filter((projectId) => this.projects.has(projectId));
  }

  async readIngestGuard(input: { connectorInstanceId: string; sourceId: string }) {
    if (this.suppressions.has(input.sourceId)) {
      return { suppressed: true, linkedTaskId: null };
    }
    return { suppressed: false, linkedTaskId: this.links.get(input.sourceId) ?? null };
  }

  async mergeExistingTask(input: {
    taskId: string;
    decide: (snapshot: {
      task: ScoutExistingTask | null;
      fieldStates: readonly TaskFieldStateRecord[];
    }) => ScoutTaskMergeDecision;
  }): Promise<ScoutTaskMergeDecision> {
    const stored = this.tasks.get(input.taskId) ?? null;
    const snapshotTask = this.mergeSnapshotOverride ?? stored;
    const decision = input.decide({
      task: snapshotTask ? { ...snapshotTask } : null,
      fieldStates: this.fieldStates.get(input.taskId) ?? [],
    });
    if (decision.kind === 'skip') return decision;

    this.mergeWrites.push(decision);
    if (decision.taskWrite && stored) {
      this.tasks.set(input.taskId, {
        ...stored,
        ...decision.taskWrite.rendered,
        metadata: decision.taskWrite.metadata,
      });
    }
    this.fieldStates.set(
      input.taskId,
      decision.observations.map((observation) => ({
        taskId: input.taskId,
        fieldName: observation.fieldName,
        sourceValue: observation.sourceValue,
        locallyOverridden: observation.locallyOverridden,
        sourceObservedAt: observation.sourceObservedAt,
        localEditedAt: observation.localEditedAt,
        updatedAt: observation.updatedAt,
      })),
    );
    return decision;
  }

  async createTask(input: ScoutTaskCreationInput) {
    if (this.suppressions.has(input.sourceId)) return { kind: 'suppressed' } as const;
    if (this.conflictWinnerId) {
      const taskId = this.conflictWinnerId;
      this.conflictWinnerId = null;
      return { kind: 'conflict', taskId } as const;
    }
    this.creations.push(input);
    this.tasks.set(input.taskId, {
      id: input.taskId,
      sourceId: input.sourceId,
      connectorType: input.connectorType,
      title: input.title,
      description: input.description,
      priority: input.priority,
      dueDate: input.dueDate,
      metadata: input.metadata,
      status: input.status,
      snoozedUntil: null,
    });
    return { kind: 'created' } as const;
  }

  async linkSourceToTask(input: ScoutLinkSourceInput) {
    if (this.suppressions.has(input.sourceId)) return { kind: 'suppressed' } as const;
    this.linkWrites.push(input);
    this.links.set(input.sourceId, input.taskId);
    return { kind: 'linked' } as const;
  }

  async upsertTriageItem(input: ScoutTriageUpsertInput) {
    this.triageWrites.push(input);
    const existing = this.triageItems.get(input.sourceId);
    if (existing && (existing.status === 'actioned' || existing.status === 'dismissed')) {
      return { kind: 'closed', triageItemId: existing.id } as const;
    }
    if (existing) return { kind: 'updated', triageItemId: existing.id } as const;
    this.triageItems.set(input.sourceId, { id: input.triageItemId, status: 'pending' });
    return { kind: 'created', triageItemId: input.triageItemId } as const;
  }

  async refreshSourceListCounts(refreshes: readonly { sourceListId: string }[]) {
    this.countRefreshes.push(...refreshes.map((refresh) => ({ ...refresh })));
  }
}

export function describeScoutIngestionReconciliationContract(
  backend: string,
  getHarness: () => ScoutPersistenceContractHarness,
): void {
  describe(`${backend} Scout ingestion persistence contract`, () => {
    it('bootstraps the connector exactly once and reports its stored settings', async () => {
      const harness = getHarness();
      await harness.reset();

      const first = await harness.persistence.ingestion.bootstrapConnector({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        now: SCOUT_NOW,
        defaults: CONNECTOR_DEFAULTS,
        sourceLists: [SOURCE_LIST],
      });
      const second = await harness.persistence.ingestion.bootstrapConnector({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        now: SCOUT_NOW,
        defaults: CONNECTOR_DEFAULTS,
        sourceLists: [SOURCE_LIST],
      });

      expect(first).toMatchObject({ existed: false, enabled: true, settings: null });
      expect(second.existed).toBe(true);
      expect(second.enabled).toBe(true);
      expect(await harness.readSourceList(SOURCE_LIST.sourceId)).toMatchObject({
        name: 'Email Actions',
      });
    });

    it('reports a disabled connector without rewriting its settings', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedConnector({
        id: CONNECTOR_INSTANCE_ID,
        type: 'scout',
        enabled: false,
        settings: { landingMode: 'triage' },
      });

      const bootstrap = await harness.persistence.ingestion.bootstrapConnector({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        now: SCOUT_NOW,
        defaults: CONNECTOR_DEFAULTS,
        sourceLists: [SOURCE_LIST],
      });

      expect(bootstrap.existed).toBe(true);
      expect(bootstrap.enabled).toBe(false);
    });

    it('creates a task once and converges a unique-conflict onto the stored winner', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.persistence.ingestion.ensureSourceList({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        definition: SOURCE_LIST,
        now: SCOUT_NOW,
      });
      await harness.seedProject('project-1');

      const creation = {
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorType: 'scout',
        taskId: 'scout-task-1',
        sourceId: 'scout:email:1',
        title: 'Reply to Johnson',
        description: 'Body',
        status: 'todo',
        priority: 'medium',
        dueDate: null,
        sourceListId: SOURCE_LIST.sourceId,
        sourceListName: SOURCE_LIST.name,
        metadata: JSON.stringify({ scout: { sourceType: 'email' } }),
        now: SCOUT_NOW,
        fieldStates: [
          {
            fieldName: 'title',
            sourceValue: JSON.stringify('Reply to Johnson'),
            locallyOverridden: false,
            sourceObservedAt: SCOUT_NOW,
            localEditedAt: null,
            updatedAt: SCOUT_NOW,
          },
        ],
        tags: [{
          id: 'tag-work',
          name: 'work',
          slug: 'work',
          type: 'hub',
          source: null,
          color: '#6b7280',
          confirmed: true,
          createdAt: SCOUT_NOW,
        }],
        projectId: 'project-1',
      };

      expect(await harness.persistence.ingestion.createTask(creation))
        .toEqual({ kind: 'created' });
      expect(await harness.persistence.ingestion.createTask({
        ...creation,
        taskId: 'scout-task-loser',
      })).toEqual({ kind: 'conflict', taskId: 'scout-task-1' });

      expect(await harness.readTask('scout-task-1')).toMatchObject({
        title: 'Reply to Johnson',
        status: 'todo',
      });
      expect(await harness.readFieldStates('scout-task-1')).toEqual([
        { fieldName: 'title', sourceValue: JSON.stringify('Reply to Johnson'), locallyOverridden: false },
      ]);
      expect(await harness.countTaskTags('scout-task-1')).toBe(1);
    });

    it('suppresses creation and linking for a tombstoned source', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedSuppression({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        sourceId: 'scout:email:tombstoned',
      });
      await harness.seedTask({
        id: 'other-task',
        sourceId: 'gh:1',
        connectorType: 'github-issues',
        connectorInstanceId: 'github',
        title: 'Other',
        status: 'todo',
      });

      expect(await harness.persistence.ingestion.readIngestGuard({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        sourceId: 'scout:email:tombstoned',
      })).toEqual({ suppressed: true, linkedTaskId: null });

      expect(await harness.persistence.ingestion.createTask({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorType: 'scout',
        taskId: 'scout-task-tombstoned',
        sourceId: 'scout:email:tombstoned',
        title: 'Should not exist',
        description: null,
        status: 'todo',
        priority: 'none',
        dueDate: null,
        sourceListId: '',
        sourceListName: null,
        metadata: '{}',
        now: SCOUT_NOW,
        fieldStates: [],
        tags: [],
        projectId: null,
      })).toEqual({ kind: 'suppressed' });

      expect(await harness.persistence.ingestion.linkSourceToTask({
        id: 'link-1',
        taskId: 'other-task',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        sourceId: 'scout:email:tombstoned',
        title: 'Should not link',
        linkedAt: SCOUT_NOW,
        matchConfidence: 0.9,
        metadata: '{}',
      })).toEqual({ kind: 'suppressed' });

      expect(await harness.readTask('scout-task-tombstoned')).toBeNull();
      expect(await harness.countLinkedSources()).toBe(0);
    });

    it('links a source once and reports the existing link on replay', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedTask({
        id: 'other-task',
        sourceId: 'gh:1',
        connectorType: 'github-issues',
        connectorInstanceId: 'github',
        title: 'Other',
        status: 'todo',
      });

      const link = {
        id: 'link-1',
        taskId: 'other-task',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        sourceId: 'scout:email:linked',
        title: 'Linked',
        linkedAt: SCOUT_NOW,
        matchConfidence: 0.9,
        metadata: JSON.stringify({ sourceType: 'email' }),
      };
      expect(await harness.persistence.ingestion.linkSourceToTask(link))
        .toEqual({ kind: 'linked' });
      expect(await harness.persistence.ingestion.linkSourceToTask({ ...link, id: 'link-2' }))
        .toEqual({ kind: 'linked' });

      expect(await harness.countLinkedSources()).toBe(1);
      expect(await harness.persistence.ingestion.readIngestGuard({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        sourceId: 'scout:email:linked',
      })).toEqual({ suppressed: false, linkedTaskId: 'other-task' });
    });

    it('merges an existing task atomically and preserves local overrides', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedTask({
        id: 'scout-task-1',
        sourceId: 'scout:email:1',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'Local title',
        status: 'todo',
        priority: 'none',
      });

      const decision = await harness.persistence.ingestion.mergeExistingTask({
        taskId: 'scout-task-1',
        decide: (snapshot) => {
          expect(snapshot.task?.title).toBe('Local title');
          expect(snapshot.fieldStates).toEqual([]);
          return {
            kind: 'apply',
            observations: [
              {
                fieldName: 'title',
                sourceValue: JSON.stringify('Source title'),
                locallyOverridden: true,
                sourceObservedAt: SCOUT_NOW,
                localEditedAt: SCOUT_NOW,
                updatedAt: SCOUT_NOW,
              },
              {
                fieldName: 'priority',
                sourceValue: JSON.stringify('high'),
                locallyOverridden: false,
                sourceObservedAt: SCOUT_NOW,
                localEditedAt: null,
                updatedAt: SCOUT_NOW,
              },
            ],
            taskWrite: {
              rendered: { priority: 'high' },
              metadata: JSON.stringify({ scout: { refreshed: true } }),
              updatedAt: SCOUT_NOW,
              lastSyncedAt: SCOUT_NOW,
            },
          };
        },
      });

      expect(decision.kind).toBe('apply');
      const stored = await harness.readTask('scout-task-1');
      expect(stored).toMatchObject({ title: 'Local title', priority: 'high' });
      expect(await harness.readFieldStates('scout-task-1')).toEqual([
        { fieldName: 'priority', sourceValue: JSON.stringify('high'), locallyOverridden: false },
        { fieldName: 'title', sourceValue: JSON.stringify('Source title'), locallyOverridden: true },
      ]);
    });

    it('reports a skip decision without writing anything', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedTask({
        id: 'scout-task-1',
        sourceId: 'scout:email:1',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'Closed',
        status: 'done',
      });

      const decision = await harness.persistence.ingestion.mergeExistingTask({
        taskId: 'scout-task-1',
        decide: (snapshot) => (snapshot.task?.status === 'done'
          ? { kind: 'skip', reason: 'task_closed' }
          : { kind: 'apply', observations: [], taskWrite: null }),
      });

      expect(decision).toEqual({ kind: 'skip', reason: 'task_closed' });
      expect(await harness.readFieldStates('scout-task-1')).toEqual([]);
    });

    it('never reopens an actioned triage row and refreshes an open one', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedTriageItem({
        id: 'triage-closed',
        sourcePlatform: 'scout',
        sourceId: 'scout:email:closed',
        title: 'Closed item',
        status: 'actioned',
      });
      await harness.seedTriageItem({
        id: 'triage-open',
        sourcePlatform: 'scout',
        sourceId: 'scout:email:open',
        title: 'Open item',
        status: 'pending',
      });

      const values = {
        sourceUrl: 'scout://item/x',
        canonicalUrl: 'scout://item/x',
        title: 'Refreshed',
        description: null,
        contentType: 'text_post',
        capturedAt: SCOUT_NOW,
        aiSummary: null,
        aiCategories: ['email'],
        aiSuggestedActions: [],
        aiRelevanceScore: 50,
        aiUrgency: 'evergreen',
        rawMetadata: { connectorType: 'scout' },
      };

      expect(await harness.persistence.ingestion.upsertTriageItem({
        triageItemId: 'triage-new-1',
        sourcePlatform: 'scout',
        sourceId: 'scout:email:closed',
        ingestedAt: SCOUT_NOW,
        values,
      })).toEqual({ kind: 'closed', triageItemId: 'triage-closed' });
      expect(await harness.readTriageItem({
        sourcePlatform: 'scout',
        sourceId: 'scout:email:closed',
      })).toMatchObject({ title: 'Closed item', status: 'actioned' });

      expect(await harness.persistence.ingestion.upsertTriageItem({
        triageItemId: 'triage-new-2',
        sourcePlatform: 'scout',
        sourceId: 'scout:email:open',
        ingestedAt: SCOUT_NOW,
        values,
      })).toEqual({ kind: 'updated', triageItemId: 'triage-open' });

      expect(await harness.persistence.ingestion.upsertTriageItem({
        triageItemId: 'triage-new-3',
        sourcePlatform: 'scout',
        sourceId: 'scout:email:fresh',
        ingestedAt: SCOUT_NOW,
        values,
      })).toEqual({ kind: 'created', triageItemId: 'triage-new-3' });
    });

    it('filters project identifiers and refreshes source-list counts', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedProject('project-1');
      await harness.persistence.ingestion.ensureSourceList({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        definition: SOURCE_LIST,
        now: SCOUT_NOW,
      });
      await harness.seedTask({
        id: 'scout-task-1',
        sourceId: 'scout:email:1',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'One',
        status: 'todo',
        sourceListId: SOURCE_LIST.sourceId,
      });

      expect(await harness.persistence.ingestion.filterExistingProjectIds([
        'project-missing',
        'project-1',
      ])).toEqual(['project-1']);

      await harness.persistence.ingestion.refreshSourceListCounts([{
        connectorType: 'scout',
        sourceListId: SOURCE_LIST.sourceId,
        syncedAt: SCOUT_NOW,
      }]);
      expect(await harness.readSourceList(SOURCE_LIST.sourceId)).toMatchObject({ taskCount: 1 });
    });

    it('snapshots only open non-Scout tasks for cross-connector matching', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedTask({
        id: 'gh-open',
        sourceId: 'gh:1',
        connectorType: 'github-issues',
        connectorInstanceId: 'github',
        title: 'Open issue',
        status: 'todo',
      });
      await harness.seedTask({
        id: 'gh-done',
        sourceId: 'gh:2',
        connectorType: 'github-issues',
        connectorInstanceId: 'github',
        title: 'Closed issue',
        status: 'done',
      });
      await harness.seedTask({
        id: 'scout-open',
        sourceId: 'scout:email:1',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'Scout item',
        status: 'todo',
      });

      const candidates = await harness.persistence.ingestion.listCrossConnectorCandidates({
        excludeConnectorType: 'scout',
        closedStatuses: ['done', 'cancelled'],
      });
      expect(candidates.map((candidate) => candidate.id)).toEqual(['gh-open']);
    });

    it('projects the parallel-comparison window from the requested instant', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedTask({
        id: 'scout-old',
        sourceId: 'scout:email:old',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'Old',
        status: 'todo',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await harness.seedTask({
        id: 'scout-new',
        sourceId: 'scout:email:new',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'New',
        status: 'todo',
        createdAt: SCOUT_NOW,
      });
      await harness.seedTask({
        id: 'outlook-new',
        sourceId: 'outlook:1',
        connectorType: 'outlook-email',
        connectorInstanceId: 'outlook',
        title: 'New',
        status: 'todo',
        createdAt: SCOUT_NOW,
      });

      const window = await harness.persistence.comparison.readWindow({
        since: '2026-09-01T00:00:00.000Z',
        scoutConnectorType: 'scout',
        comparisonConnectorType: 'outlook-email',
      });
      expect(window.scoutTasks.map((task) => task.id)).toEqual(['scout-new']);
      expect(window.comparisonTasks.map((task) => task.id)).toEqual(['outlook-new']);
      expect(window.linkedPairs).toEqual([]);
    });
  });

  describe(`${backend} Scout reconciliation persistence contract`, () => {
    async function seedOpenScoutTask(
      harness: ScoutPersistenceContractHarness,
      taskId = 'task-1',
    ): Promise<void> {
      await harness.seedConnector({
        id: CONNECTOR_INSTANCE_ID,
        type: 'scout',
        enabled: true,
        settings: { landingMode: 'direct' },
      });
      await harness.seedTask({
        id: taskId,
        sourceId: `scout:email:${taskId}`,
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: `Task ${taskId}`,
        status: 'todo',
        priority: 'medium',
      });
    }

    function runRecord(overrides: Partial<{
      id: string;
      idempotencyKey: string;
      requestHash: string;
      leaseToken: string;
      scopeKey: string;
      dryRun: boolean;
    }> = {}) {
      return {
        id: overrides.id ?? 'run-1',
        scopeKey: overrides.scopeKey ?? 'task:task-1',
        scopeType: 'task' as const,
        scopeId: 'task-1',
        lookbackHours: 48,
        dryRun: overrides.dryRun ?? false,
        source: 'api' as const,
        sourceIdentity: 'contract',
        idempotencyKey: overrides.idempotencyKey ?? 'key-1',
        requestHash: overrides.requestHash ?? 'hash-1',
        leaseToken: overrides.leaseToken ?? 'lease-1',
        startedAt: SCOUT_NOW,
      };
    }

    it('fences run creation on the idempotency key and the active scope', async () => {
      const harness = getHarness();
      await harness.reset();
      await seedOpenScoutTask(harness);
      const repository = harness.persistence.reconciliation;

      expect(await repository.createRun(runRecord())).toEqual({ kind: 'created' });
      expect(await repository.createRun(runRecord({ id: 'run-2', leaseToken: 'lease-2' })))
        .toEqual({ kind: 'conflict' });
      expect(await repository.createRun(runRecord({
        id: 'run-3',
        idempotencyKey: 'key-3',
        leaseToken: 'lease-3',
      }))).toEqual({ kind: 'conflict' });

      expect(await repository.findRunByIdempotencyKey('key-1')).toMatchObject({
        id: 'run-1',
        requestHash: 'hash-1',
        status: 'running',
        dryRun: false,
      });
      expect(await repository.findRunByIdempotencyKey('missing')).toBeNull();
    });

    it('expires a stale run and lets exactly one caller resume it', async () => {
      const harness = getHarness();
      await harness.reset();
      await seedOpenScoutTask(harness);
      const repository = harness.persistence.reconciliation;
      await repository.createRun(runRecord());

      await repository.expireStaleRuns({
        scopeKey: 'task:task-1',
        startedBefore: '2026-09-08T13:00:00.000Z',
        completedAt: SCOUT_NOW,
        error: 'Run lock expired before completion',
      });
      expect(await harness.readRunStatus('run-1')).toBe('failed');

      expect(await repository.resumeFailedRun({
        runId: 'run-1',
        leaseToken: 'lease-2',
        startedAt: SCOUT_NOW,
      })).toBe(true);
      expect(await repository.resumeFailedRun({
        runId: 'run-1',
        leaseToken: 'lease-3',
        startedAt: SCOUT_NOW,
      })).toBe(false);
    });

    it('commits every evaluation, suggestion, digest, and summary atomically', async () => {
      const harness = getHarness();
      await harness.reset();
      await seedOpenScoutTask(harness);
      const repository = harness.persistence.reconciliation;
      await repository.createRun(runRecord());

      const result = await repository.commitRun<{ taskId: string }, { taskId: string }>({
        runId: 'run-1',
        leaseToken: 'lease-1',
        completedAt: SCOUT_NOW,
        plans: [{
          plan: { taskId: 'task-1' },
          taskId: 'task-1',
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          evidenceHash: 'evidence-1',
        }],
        decide: (plan, context: ScoutEvaluationContext) => {
          expect(context.currentTask).toMatchObject({ id: 'task-1', status: 'todo' });
          expect(context.connector).toMatchObject({ enabled: true });
          expect(context.pendingSuggestion).toBeNull();
          return {
            evaluation: {
              id: 'evaluation-1',
              runId: 'run-1',
              taskId: plan.taskId,
              candidateAction: 'auto-complete',
              action: 'suggest-complete',
              confidence: 0.9,
              evidenceHash: 'evidence-1',
              evidence: evidence('evidence-1'),
              policyDecision: 'require-confirmation',
              policyReason: 'confirmation required',
              payloadHash: 'payload-1',
              applied: false,
              appliedResult: null,
              createdAt: SCOUT_NOW,
            },
            effect: {
              kind: 'insert-suggestion',
              supersede: null,
              suggestion: {
                id: 'suggestion-1',
                taskId: plan.taskId,
                runId: 'run-1',
                evaluationId: 'evaluation-1',
                action: 'suggest-complete',
                status: 'pending',
                confidence: 0.9,
                evidenceHash: 'evidence-1',
                evidence: evidence('evidence-1'),
                policyDecision: 'require-confirmation',
                policyReason: 'confirmation required',
                payloadHash: 'payload-1',
                proposedEffect: { taskId: plan.taskId, status: 'done' },
                createdAt: SCOUT_NOW,
                updatedAt: SCOUT_NOW,
                expiresAt: '2026-09-22T12:00:00.000Z',
              },
              appliedResult: { suggestionId: 'suggestion-1' },
            },
            result: { taskId: plan.taskId },
          };
        },
        summarize: (results) => ({ suggestedComplete: results.length }),
        digest: (summary) => ({
          id: 'notification-1',
          sourceId: 'scout-reconciliation:run-1',
          connectorType: 'scout',
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          title: 'Scout reconciliation finished',
          body: `${summary.suggestedComplete} ready for review`,
          level: 'heads_up',
          levelRank: 2,
          category: 'automation',
          templateKey: 'scout_reconciliation_digest',
          state: 'unread',
          isActionable: false,
          receivedAt: SCOUT_NOW,
          sortAt: SCOUT_NOW,
          groupKey: 'scout-reconciliation',
          dedupeKey: 'scout-reconciliation:run-1',
          navigationTarget: '/scout/reconciliation',
          metadata: { runId: 'run-1' },
          presentation: { sourceName: 'Scout' },
        }),
      });

      expect(result.summary).toEqual({ suggestedComplete: 1 });
      expect(result.results).toEqual([{ taskId: 'task-1' }]);
      expect(await harness.readRunStatus('run-1')).toBe('completed');
      expect(await harness.countEvaluations()).toBe(1);
      expect(await harness.countNotifications()).toBe(1);
      expect(await harness.listSuggestions()).toEqual([
        { id: 'suggestion-1', taskId: 'task-1', status: 'pending', evidenceHash: 'evidence-1' },
      ]);

      const replay = await repository.loadRunEvaluations('run-1');
      expect(replay).toEqual([expect.objectContaining({
        taskId: 'task-1',
        title: 'Task task-1',
        action: 'suggest-complete',
        applied: false,
        appliedResult: { suggestionId: 'suggestion-1' },
      })]);
    });

    it('rolls the whole run back when a later evaluation throws', async () => {
      const harness = getHarness();
      await harness.reset();
      await seedOpenScoutTask(harness);
      await harness.seedTask({
        id: 'task-2',
        sourceId: 'scout:email:task-2',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'Task task-2',
        status: 'todo',
      });
      const repository = harness.persistence.reconciliation;
      await repository.createRun(runRecord({ scopeKey: 'all' }));

      await expect(repository.commitRun<{ taskId: string }, { taskId: string }>({
        runId: 'run-1',
        leaseToken: 'lease-1',
        completedAt: SCOUT_NOW,
        plans: [
          { plan: { taskId: 'task-1' }, taskId: 'task-1', connectorInstanceId: CONNECTOR_INSTANCE_ID, evidenceHash: 'e1' },
          { plan: { taskId: 'task-2' }, taskId: 'task-2', connectorInstanceId: CONNECTOR_INSTANCE_ID, evidenceHash: 'e2' },
        ],
        decide: (plan) => {
          if (plan.taskId === 'task-2') throw new Error('synthetic evaluation failure');
          return {
            evaluation: {
              id: `evaluation-${plan.taskId}`,
              runId: 'run-1',
              taskId: plan.taskId,
              candidateAction: 'auto-complete',
              action: 'auto-complete',
              confidence: 1,
              evidenceHash: 'e1',
              evidence: evidence('e1'),
              policyDecision: 'allow',
              policyReason: 'allowed',
              payloadHash: 'payload',
              applied: false,
              appliedResult: null,
              createdAt: SCOUT_NOW,
            },
            effect: {
              kind: 'complete-task',
              taskId: plan.taskId,
              completion: {
                columns: {
                  status: 'done',
                  status_reason: 'completed',
                  completed_at: SCOUT_NOW,
                  updated_at: SCOUT_NOW,
                },
                expectedStatuses: ['todo', 'in_progress'],
              },
              supersedePending: {
                status: 'superseded',
                updatedAt: SCOUT_NOW,
                actedAt: SCOUT_NOW,
                actedBy: 'reconciliation',
              },
              appliedResult: { status: 'done' },
            },
            result: { taskId: plan.taskId },
          };
        },
        summarize: () => ({ autoCompleted: 1 }),
        digest: () => null,
      })).rejects.toThrow('synthetic evaluation failure');

      expect(await harness.countEvaluations()).toBe(0);
      expect(await harness.readTask('task-1')).toMatchObject({ status: 'todo' });
      expect(await harness.readRunStatus('run-1')).toBe('running');
    });

    it('expires and supersedes pending suggestions before listing them', async () => {
      const harness = getHarness();
      await harness.reset();
      await seedOpenScoutTask(harness);
      await harness.seedTask({
        id: 'task-terminal',
        sourceId: 'scout:email:terminal',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'Terminal',
        status: 'done',
      });
      const repository = harness.persistence.reconciliation;
      await repository.createRun(runRecord());
      await repository.commitRun<{ taskId: string; suggestionId: string; expiresAt: string }, null>({
        runId: 'run-1',
        leaseToken: 'lease-1',
        completedAt: SCOUT_NOW,
        plans: [
          {
            plan: { taskId: 'task-1', suggestionId: 'suggestion-open', expiresAt: '2026-09-22T12:00:00.000Z' },
            taskId: 'task-1',
            connectorInstanceId: CONNECTOR_INSTANCE_ID,
            evidenceHash: 'e1',
          },
          {
            plan: { taskId: 'task-terminal', suggestionId: 'suggestion-terminal', expiresAt: '2026-09-22T12:00:00.000Z' },
            taskId: 'task-terminal',
            connectorInstanceId: CONNECTOR_INSTANCE_ID,
            evidenceHash: 'e2',
          },
        ],
        decide: (plan) => ({
          evaluation: {
            id: `evaluation-${plan.suggestionId}`,
            runId: 'run-1',
            taskId: plan.taskId,
            candidateAction: 'suggest-complete',
            action: 'suggest-complete',
            confidence: 0.8,
            evidenceHash: plan.suggestionId,
            evidence: evidence(plan.suggestionId),
            policyDecision: 'require-confirmation',
            policyReason: 'confirmation required',
            payloadHash: `payload-${plan.suggestionId}`,
            applied: false,
            appliedResult: null,
            createdAt: SCOUT_NOW,
          },
          effect: {
            kind: 'insert-suggestion',
            supersede: null,
            suggestion: {
              id: plan.suggestionId,
              taskId: plan.taskId,
              runId: 'run-1',
              evaluationId: `evaluation-${plan.suggestionId}`,
              action: 'suggest-complete',
              status: 'pending',
              confidence: 0.8,
              evidenceHash: plan.suggestionId,
              evidence: evidence(plan.suggestionId),
              policyDecision: 'require-confirmation',
              policyReason: 'confirmation required',
              payloadHash: `payload-${plan.suggestionId}`,
              proposedEffect: { taskId: plan.taskId },
              createdAt: SCOUT_NOW,
              updatedAt: SCOUT_NOW,
              expiresAt: plan.expiresAt,
            },
            appliedResult: { suggestionId: plan.suggestionId },
          },
          result: null,
        }),
        summarize: () => ({ suggestedComplete: 2 }),
        digest: () => null,
      });

      const listed = await repository.listPendingSuggestions({
        now: SCOUT_NOW,
        limit: 100,
        openStatuses: ['todo', 'in_progress'],
        terminalStatuses: ['done', 'cancelled'],
      });
      expect(listed.map((row) => row.id)).toEqual(['suggestion-open']);
      expect(listed[0]).toMatchObject({
        taskTitle: 'Task task-1',
        payloadHash: 'payload-suggestion-open',
        proposedEffect: { taskId: 'task-1' },
      });
      const stored = await harness.listSuggestions();
      expect(stored.find((row) => row.id === 'suggestion-terminal')?.status).toBe('superseded');
    });

    it('fences suggestion acceptance on the payload hash and applies it atomically', async () => {
      const harness = getHarness();
      await harness.reset();
      await seedOpenScoutTask(harness);
      const repository = harness.persistence.reconciliation;
      await repository.createRun(runRecord());
      await repository.commitRun<{ taskId: string }, null>({
        runId: 'run-1',
        leaseToken: 'lease-1',
        completedAt: SCOUT_NOW,
        plans: [{
          plan: { taskId: 'task-1' },
          taskId: 'task-1',
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          evidenceHash: 'e1',
        }],
        decide: (plan) => ({
          evaluation: {
            id: 'evaluation-1',
            runId: 'run-1',
            taskId: plan.taskId,
            candidateAction: 'suggest-complete',
            action: 'suggest-complete',
            confidence: 0.8,
            evidenceHash: 'e1',
            evidence: evidence('e1'),
            policyDecision: 'require-confirmation',
            policyReason: 'confirmation required',
            payloadHash: 'payload-1',
            applied: false,
            appliedResult: null,
            createdAt: SCOUT_NOW,
          },
          effect: {
            kind: 'insert-suggestion',
            supersede: null,
            suggestion: {
              id: 'suggestion-1',
              taskId: plan.taskId,
              runId: 'run-1',
              evaluationId: 'evaluation-1',
              action: 'suggest-complete',
              status: 'pending',
              confidence: 0.8,
              evidenceHash: 'e1',
              evidence: evidence('e1'),
              policyDecision: 'require-confirmation',
              policyReason: 'confirmation required',
              payloadHash: 'payload-1',
              proposedEffect: { taskId: plan.taskId },
              createdAt: SCOUT_NOW,
              updatedAt: SCOUT_NOW,
              expiresAt: '2026-09-22T12:00:00.000Z',
            },
            appliedResult: { suggestionId: 'suggestion-1' },
          },
          result: null,
        }),
        summarize: () => ({ suggestedComplete: 1 }),
        digest: () => null,
      });

      await expect(repository.actOnSuggestion({
        suggestionId: 'suggestion-1',
        decide: (snapshot) => {
          expect(snapshot.suggestion).toMatchObject({
            id: 'suggestion-1',
            status: 'pending',
            payloadHash: 'payload-1',
          });
          expect(snapshot.task).toMatchObject({ id: 'task-1' });
          expect(snapshot.connector).toMatchObject({ enabled: true });
          return {
            kind: 'accept',
            result: 'accepted',
            expectedPayloadHash: 'wrong-hash',
            suggestionUpdate: {
              status: 'accepted',
              updatedAt: SCOUT_NOW,
              actedAt: SCOUT_NOW,
              actedBy: 'tester',
            },
            taskId: 'task-1',
            completion: {
              columns: {
                status: 'done',
                status_reason: 'completed',
                completed_at: SCOUT_NOW,
                updated_at: SCOUT_NOW,
              },
              expectedStatuses: ['todo', 'in_progress'],
            },
            evaluationId: 'evaluation-1',
            appliedResult: { status: 'done' },
          };
        },
      })).rejects.toMatchObject({ code: 'suggestion-acted-concurrently' });
      expect(await harness.readTask('task-1')).toMatchObject({ status: 'todo' });

      const accepted = await repository.actOnSuggestion({
        suggestionId: 'suggestion-1',
        decide: () => ({
          kind: 'accept',
          result: 'accepted',
          expectedPayloadHash: 'payload-1',
          suggestionUpdate: {
            status: 'accepted',
            updatedAt: SCOUT_NOW,
            actedAt: SCOUT_NOW,
            actedBy: 'tester',
          },
          taskId: 'task-1',
          completion: {
            columns: {
              status: 'done',
              status_reason: 'completed',
              completed_at: SCOUT_NOW,
              updated_at: SCOUT_NOW,
            },
            expectedStatuses: ['todo', 'in_progress'],
          },
          evaluationId: 'evaluation-1',
          appliedResult: { status: 'done', confirmationActor: 'tester' },
        }),
      });

      expect(accepted).toBe('accepted');
      expect(await harness.readTask('task-1')).toMatchObject({
        status: 'done',
        statusReason: 'completed',
      });
      expect(await repository.hasAppliedAutoCompletion('task-1')).toBe(false);
      expect((await harness.listSuggestions())[0].status).toBe('accepted');
    });

    it('persists a never-auto-complete dismissal and reports it back to the run', async () => {
      const harness = getHarness();
      await harness.reset();
      await seedOpenScoutTask(harness);
      const repository = harness.persistence.reconciliation;
      await repository.createRun(runRecord());
      await repository.commitRun<{ taskId: string }, null>({
        runId: 'run-1',
        leaseToken: 'lease-1',
        completedAt: SCOUT_NOW,
        plans: [{
          plan: { taskId: 'task-1' },
          taskId: 'task-1',
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          evidenceHash: 'e1',
        }],
        decide: (plan) => ({
          evaluation: {
            id: 'evaluation-1',
            runId: 'run-1',
            taskId: plan.taskId,
            candidateAction: 'suggest-complete',
            action: 'suggest-complete',
            confidence: 0.8,
            evidenceHash: 'e1',
            evidence: evidence('e1'),
            policyDecision: 'require-confirmation',
            policyReason: 'confirmation required',
            payloadHash: 'payload-1',
            applied: false,
            appliedResult: null,
            createdAt: SCOUT_NOW,
          },
          effect: {
            kind: 'insert-suggestion',
            supersede: null,
            suggestion: {
              id: 'suggestion-1',
              taskId: plan.taskId,
              runId: 'run-1',
              evaluationId: 'evaluation-1',
              action: 'suggest-complete',
              status: 'pending',
              confidence: 0.8,
              evidenceHash: 'e1',
              evidence: evidence('e1'),
              policyDecision: 'require-confirmation',
              policyReason: 'confirmation required',
              payloadHash: 'payload-1',
              proposedEffect: { taskId: plan.taskId },
              createdAt: SCOUT_NOW,
              updatedAt: SCOUT_NOW,
              expiresAt: '2026-09-22T12:00:00.000Z',
            },
            appliedResult: { suggestionId: 'suggestion-1' },
          },
          result: null,
        }),
        summarize: () => ({ suggestedComplete: 1 }),
        digest: () => null,
      });

      await repository.actOnSuggestion({
        suggestionId: 'suggestion-1',
        decide: () => ({
          kind: 'dismiss',
          result: 'dismissed',
          expectedPayloadHash: 'payload-1',
          suggestionUpdate: {
            status: 'dismissed',
            updatedAt: SCOUT_NOW,
            actedAt: SCOUT_NOW,
            actedBy: 'tester',
          },
          taskState: {
            taskId: 'task-1',
            neverAutoComplete: true,
            reason: 'user_requested',
            sourceRunId: 'run-1',
            updatedAt: SCOUT_NOW,
            updatedBy: 'tester',
          },
        }),
      });

      expect(await repository.listTaskStates(['task-1'])).toEqual([{
        taskId: 'task-1',
        neverAutoComplete: true,
        reason: 'user_requested',
        sourceRunId: 'run-1',
        updatedAt: SCOUT_NOW,
        updatedBy: 'tester',
      }]);
      expect((await harness.listSuggestions())[0].status).toBe('dismissed');
    });

    it('scopes task listing by project and task while excluding closed work', async () => {
      const harness = getHarness();
      await harness.reset();
      await seedOpenScoutTask(harness);
      await harness.seedTask({
        id: 'task-2',
        sourceId: 'scout:email:task-2',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'Task task-2',
        status: 'todo',
      });
      await harness.seedTask({
        id: 'task-done',
        sourceId: 'scout:email:done',
        connectorType: 'scout',
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        title: 'Done',
        status: 'done',
      });
      await harness.seedProject('project-1');
      await harness.seedTaskProject({ taskId: 'task-1', projectId: 'project-1' });
      const repository = harness.persistence.reconciliation;

      expect((await repository.listScopedTasks({
        type: 'all',
        id: null,
        openStatuses: ['todo', 'in_progress'],
        connectorType: 'scout',
        limit: 201,
      })).map((task) => task.id)).toEqual(['task-1', 'task-2']);
      expect((await repository.listScopedTasks({
        type: 'project',
        id: 'project-1',
        openStatuses: ['todo', 'in_progress'],
        connectorType: 'scout',
        limit: 201,
      })).map((task) => task.id)).toEqual(['task-1']);
      expect((await repository.listScopedTasks({
        type: 'task',
        id: 'task-2',
        openStatuses: ['todo', 'in_progress'],
        connectorType: 'scout',
        limit: 201,
      })).map((task) => task.id)).toEqual(['task-2']);
    });
  });
}

export function describeTriageActionPersistenceContract(
  backend: string,
  getHarness: () => TriageActionContractHarness,
): void {
  describe(`${backend} triage action persistence contract`, () => {
    it('reserves a task-creation claim exactly once', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedItem(triageItemFixture());

      expect(await harness.actions.reserveClaim({
        claimId: 'claim-1',
        triageItemId: 'triage-1',
        actionType: 'create_task_todo',
        claimedAt: TRIAGE_ACTION_NOW,
      })).toEqual({ acquired: true });
      expect(await harness.actions.reserveClaim({
        claimId: 'claim-2',
        triageItemId: 'triage-1',
        actionType: 'create_task_todo',
        claimedAt: TRIAGE_ACTION_NOW,
      })).toEqual({ acquired: false });

      expect(await harness.actions.readClaim({
        triageItemId: 'triage-1',
        actionType: 'create_task_todo',
      })).toMatchObject({ id: 'claim-1', state: 'pending' });
      expect(await harness.countClaims()).toBe(1);
    });

    it('heartbeats, retargets, and releases a pending claim under a timestamp fence', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedItem(triageItemFixture());
      await harness.actions.reserveClaim({
        claimId: 'claim-1',
        triageItemId: 'triage-1',
        actionType: 'create_task_todo',
        claimedAt: TRIAGE_ACTION_NOW,
      });

      expect(await harness.actions.heartbeatClaim({
        claimId: 'claim-1',
        claimedAt: '2026-09-08T12:00:10.000Z',
      })).toBe(true);
      expect(await harness.actions.recordClaimTarget({
        claimId: 'claim-1',
        claimedAt: '2026-09-08T12:00:20.000Z',
        target: { listId: 'list-1', listName: 'Tasks' },
      })).toBe(true);
      expect(await harness.actions.readClaim({
        triageItemId: 'triage-1',
        actionType: 'create_task_todo',
      })).toMatchObject({
        claimedAt: '2026-09-08T12:00:20.000Z',
        result: { listId: 'list-1', listName: 'Tasks' },
      });

      expect(await harness.actions.releaseClaim({
        claimId: 'claim-1',
        expectedClaimedAt: TRIAGE_ACTION_NOW,
      })).toBe(false);
      expect(await harness.actions.releaseClaim({
        claimId: 'claim-1',
        expectedClaimedAt: '2026-09-08T12:00:20.000Z',
      })).toBe(true);
      expect(await harness.countClaims()).toBe(0);
    });

    it('settles a claim and appends its action record atomically, exactly once', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedItem(triageItemFixture());
      await harness.actions.reserveClaim({
        claimId: 'claim-1',
        triageItemId: 'triage-1',
        actionType: 'create_task_todo',
        claimedAt: TRIAGE_ACTION_NOW,
      });

      const created = triageActionRecord('action-1', { actionType: 'create_task_todo' });
      const first = await harness.actions.completeClaim({
        claimId: 'claim-1',
        triageItemId: 'triage-1',
        record: created,
        completedAt: TRIAGE_ACTION_NOW,
      });
      const second = await harness.actions.completeClaim({
        claimId: 'claim-1',
        triageItemId: 'triage-1',
        record: triageActionRecord('action-2', { actionType: 'create_task_todo' }),
        completedAt: TRIAGE_ACTION_NOW,
      });

      expect(first.completed).toBe(true);
      expect(first.item).toMatchObject({ status: 'actioned', snoozedUntil: undefined });
      expect(first.item?.actionsTaken).toEqual([created]);
      expect(second.completed).toBe(false);
      expect(second.item?.actionsTaken).toEqual([created]);
    });

    it('appends an unfenced action and honours the action-version fence', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedItem(triageItemFixture());

      const first = triageActionRecord('action-1', { actionType: 'snooze' });
      const applied = await harness.actions.appendAction({
        triageItemId: 'triage-1',
        status: 'snoozed',
        snoozedUntil: '2026-09-09T12:00:00.000Z',
        record: first,
        fence: {
          actionsTaken: [],
          status: 'pending',
          snoozedUntil: null,
        },
      });
      expect(applied).toMatchObject({
        status: 'snoozed',
        snoozedUntil: '2026-09-09T12:00:00.000Z',
      });
      expect(applied?.actionsTaken).toEqual([first]);

      const stale = await harness.actions.appendAction({
        triageItemId: 'triage-1',
        status: 'dismissed',
        snoozedUntil: null,
        record: triageActionRecord('action-2'),
        fence: {
          actionsTaken: [],
          status: 'pending',
          snoozedUntil: null,
        },
      });
      expect(stale).toBeNull();

      const unfenced = await harness.actions.appendAction({
        triageItemId: 'triage-1',
        status: 'actioned',
        snoozedUntil: null,
        record: triageActionRecord('action-3', { actionType: 'save_karakeep' }),
        fence: null,
      });
      expect(unfenced?.actionsTaken.map((entry) => entry.id)).toEqual(['action-1', 'action-3']);
      expect(unfenced).toMatchObject({ status: 'actioned' });
    });

    it('compare-and-sets the whole action history for undo claims and rollbacks', async () => {
      const harness = getHarness();
      await harness.reset();
      const original = triageActionRecord('action-1', {
        actionType: 'complete_action',
        metadata: { undoPreviousStatus: 'pending', undoPreviousSnoozedUntil: null },
      });
      await harness.seedItem(triageItemFixture({
        status: 'actioned',
        actionsTaken: [original],
      }));

      const claimed: TriageActionRecord = {
        ...original,
        metadata: {
          ...original.metadata,
          undoInProgress: true,
          undoClaimId: 'undo-1',
          undoClaimedAt: TRIAGE_ACTION_NOW,
        },
      };
      const claim = await harness.actions.casActions({
        triageItemId: 'triage-1',
        actions: [claimed],
        expectedActions: [original],
      });
      expect(claim?.actionsTaken).toEqual([claimed]);

      expect(await harness.actions.casActions({
        triageItemId: 'triage-1',
        actions: [original],
        expectedActions: [original],
      })).toBeNull();

      const rolledBack = await harness.actions.casActions({
        triageItemId: 'triage-1',
        actions: [original],
        expectedActions: [claimed],
      });
      expect(rolledBack?.actionsTaken).toEqual([original]);
      expect(rolledBack).toMatchObject({ status: 'actioned' });

      const undone = await harness.actions.casActions({
        triageItemId: 'triage-1',
        actions: [],
        expectedActions: [original],
        status: 'pending',
        snoozedUntil: null,
      });
      expect(undone).toMatchObject({ status: 'pending' });
      expect(undone?.actionsTaken).toEqual([]);
    });

    it('reads a full action snapshot and reports a missing item', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedItem(triageItemFixture({ title: 'Snapshot me' }));

      expect(await harness.actions.getActionSnapshot('triage-1'))
        .toMatchObject({ id: 'triage-1', title: 'Snapshot me', status: 'pending' });
      expect(await harness.actions.getActionSnapshot('missing')).toBeNull();
    });
  });

  describe(`${backend} document-intelligence task action contract`, () => {
    it('applies a compare-and-set write only while the task identity holds', async () => {
      const harness = getHarness();
      await harness.reset();
      await harness.seedTask({
        id: 'owl-task-1',
        connectorType: 'document-intelligence',
        connectorInstanceId: 'owl',
        sourceId: 'owl:action:1',
        title: 'Pay invoice',
        status: 'todo',
        metadata: { owlStatus: 'open' },
      });

      expect(await harness.documentTaskActions.getTask('owl-task-1')).toMatchObject({
        connectorType: 'document-intelligence',
        sourceId: 'owl:action:1',
        status: 'todo',
      });
      expect(await harness.documentTaskActions.getTask('missing')).toBeNull();

      const applied = await harness.documentTaskActions.applyTaskWrite({
        taskId: 'owl-task-1',
        metadata: JSON.stringify({ owlStatus: 'completed' }),
        updatedAt: TRIAGE_ACTION_NOW,
        lastSyncedAt: TRIAGE_ACTION_NOW,
        syncStatus: 'synced',
        columns: {
          status: 'done',
          status_reason: 'completed',
          snoozed_until: null,
          completed_at: TRIAGE_ACTION_NOW,
        },
        expectedIdentity: {
          connectorType: 'document-intelligence',
          connectorInstanceId: 'owl',
          sourceId: 'owl:action:1',
        },
      });
      expect(applied).toMatchObject({
        kind: 'applied',
        task: { status: 'done', statusReason: 'completed', completedAt: TRIAGE_ACTION_NOW },
      });

      const drifted = await harness.documentTaskActions.applyTaskWrite({
        taskId: 'owl-task-1',
        metadata: JSON.stringify({ owlStatus: 'reopened' }),
        updatedAt: TRIAGE_ACTION_NOW,
        lastSyncedAt: TRIAGE_ACTION_NOW,
        syncStatus: 'synced',
        columns: { status: 'todo' },
        expectedIdentity: {
          connectorType: 'document-intelligence',
          connectorInstanceId: 'owl',
          sourceId: 'owl:action:moved',
        },
      });
      expect(drifted).toEqual({ kind: 'identity-changed' });
      expect(await harness.documentTaskActions.getTask('owl-task-1'))
        .toMatchObject({ status: 'done' });
    });
  });
}
