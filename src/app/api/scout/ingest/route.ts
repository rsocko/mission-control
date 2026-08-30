import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { tasks, tags, taskTags, taskProjects, taskFieldStates, taskIngestSuppressions, sourceLists, taskLinkedSources, connectorConfigs, triageItems, hubProjects } from '@/db/schema';
import { eq, and, ne, notInArray } from 'drizzle-orm';
import { emitEvent } from '@/lib/events';
import logger from '@/lib/logger';
import { findFuzzyMatches, isAutoLinkMatch } from '@/lib/dedup';
import {
  DEFAULT_SCOUT_SETTINGS,
  LEGACY_SCOUT_SETTINGS,
  parseScoutSettings,
  type ScoutConnectorSettings,
  type ScoutSourceType,
} from '@/lib/connectors/scout/settings';
import {
  resolveInboundSourceObservation,
  serializeTaskFieldValue,
  type TaskFieldStateRecord,
} from '@/lib/tasks/field-state';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';
import { MERGEABLE_TASK_FIELDS } from '@/lib/tasks/field-policy';
import {
  createScoutIngestResult,
  mergeScoutMetadata,
  type ScoutIngestResult,
} from '@/lib/connectors/scout/ingest-contract';
import { publishSemanticEntityUpsert } from '@/lib/semantic-index/publication';

// ─── Auth ───────────────────────────────────────────────────────────────────

/**
 * Validate the inbound request carries a valid API key.
 * If MC_API_KEY is not configured, auth is skipped (trusted-network mode).
 */
function hasValidApiKey(request: Request): boolean {
  const expected = process.env.MC_API_KEY;
  if (!expected) return true; // No key configured — open access

  const keyHeader = request.headers.get('x-mc-api-key');
  if (keyHeader && keyHeader === expected) return true;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() === expected;
  }

  return false;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface ScoutContext {
  from?: string;
  sourceSubject?: string;
  extractedAt: string;
  reasoning?: string;
  confidence?: number;
  originalSource?: Record<string, unknown>;
  relatedSourceIds?: string[];
}

interface ScoutIngestItem {
  sourceId: string;
  sourceType: ScoutSourceType;
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low' | 'none';
  dueDate?: string;
  confidence?: number;
  context?: ScoutContext;
  suggestedTags?: string[];
  suggestedProjectId?: string;
}

interface ExistingTriageItem {
  id: string;
  status: string;
}

// ─── Source List Definitions ────────────────────────────────────────────────

const SOURCE_LIST_MAP: Record<string, { id: string; name: string; type: string; icon: string; iconColor: string }> = {
  email: { id: 'scout:email-actions', name: 'Email Actions', type: 'folder', icon: 'mdi:email-outline', iconColor: '#0078d4' },
  teams: { id: 'scout:teams-actions', name: 'Teams Actions', type: 'folder', icon: 'mdi:microsoft-teams', iconColor: '#6264a7' },
  meeting: { id: 'scout:meeting-actions', name: 'Meeting Follow-ups', type: 'folder', icon: 'mdi:calendar-clock', iconColor: '#0f6cbd' },
  planner: { id: 'scout:planner-sync', name: 'Planner Tasks', type: 'list', icon: 'mdi:clipboard-check-outline', iconColor: '#31752f' },
  'cross-source': { id: 'scout:cross-source', name: 'Cross-Source Items', type: 'folder', icon: 'lucide:workflow', iconColor: '#8b5cf6' },
};

const CONNECTOR_INSTANCE_ID = 'scout-primary';

const VALID_SOURCE_TYPES = ['email', 'teams', 'meeting', 'planner', 'cross-source'] as const;
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function validateItem(item: unknown, index: number): { valid: boolean; error?: string; parsed?: ScoutIngestItem } {
  if (!item || typeof item !== 'object') {
    return { valid: false, error: `items[${index}]: must be an object` };
  }

  const obj = item as Record<string, unknown>;

  if (!obj.sourceId || typeof obj.sourceId !== 'string') {
    return { valid: false, error: `items[${index}]: sourceId is required and must be a string` };
  }
  if (!obj.sourceType || !VALID_SOURCE_TYPES.includes(obj.sourceType as typeof VALID_SOURCE_TYPES[number])) {
    return { valid: false, error: `items[${index}]: sourceType must be one of: ${VALID_SOURCE_TYPES.join(', ')}` };
  }
  if (!obj.title || typeof obj.title !== 'string') {
    return { valid: false, error: `items[${index}]: title is required and must be a string` };
  }
  if (obj.priority && !VALID_PRIORITIES.includes(obj.priority as typeof VALID_PRIORITIES[number])) {
    return { valid: false, error: `items[${index}]: priority must be one of: ${VALID_PRIORITIES.join(', ')}` };
  }
  if (obj.confidence !== undefined && (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)) {
    return { valid: false, error: `items[${index}]: confidence must be a number between 0 and 1` };
  }
  if (
    obj.suggestedTags !== undefined
    && (!Array.isArray(obj.suggestedTags) || obj.suggestedTags.some(tag => typeof tag !== 'string'))
  ) {
    return { valid: false, error: `items[${index}]: suggestedTags must be an array of strings` };
  }

  // Map scoutContext (wire format per design doc) → context (internal type)
  const parsed: ScoutIngestItem = {
    sourceId: obj.sourceId as string,
    sourceType: obj.sourceType as ScoutIngestItem['sourceType'],
    title: obj.title as string,
    description: obj.description as string | undefined,
    priority: obj.priority as ScoutIngestItem['priority'],
    dueDate: obj.dueDate as string | undefined,
    confidence: obj.confidence as number | undefined,
    context: (obj.scoutContext || obj.context) as ScoutContext | undefined,
    suggestedTags: obj.suggestedTags as string[] | undefined,
    suggestedProjectId: obj.suggestedProjectId as string | undefined,
  };

  return { valid: true, parsed };
}

/**
 * Check whether a task with this sourceId already exists for the scout connector.
 */
async function findExistingTask(sourceId: string) {
  const [existing] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      metadata: tasks.metadata,
      status: tasks.status,
      snoozedUntil: tasks.snoozedUntil,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.connectorType, 'scout'),
        eq(tasks.sourceId, sourceId),
      )
    );
  return existing || null;
}

/**
 * Fetch all open non-scout tasks (used as candidates for cross-connector matching).
 * Should be called ONCE per batch, not per-item.
 */
async function fetchCrossConnectorCandidates() {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
      metadata: tasks.metadata,
    })
    .from(tasks)
    .where(
      and(
        ne(tasks.connectorType, 'scout'),
        ne(tasks.status, 'done'),
        ne(tasks.status, 'cancelled'),
      )
    );
}

/**
 * Search for existing tasks from OTHER connectors that might match this Scout item.
 * Uses pre-fetched candidates to avoid repeated DB queries.
 */
function findCrossConnectorMatch(
  item: ScoutIngestItem,
  candidates: Array<{ id: string; title: string; connectorType: string; connectorInstanceId: string; sourceId: string; metadata: unknown }>,
): { taskId: string; title: string; score: number; connectorType: string; connectorInstanceId: string; sourceId: string } | null {
  if (candidates.length === 0) return null;

  const matches = findFuzzyMatches(
    item.title,
    candidates.map(c => ({
      id: c.id,
      title: c.title,
      connectorType: c.connectorType,
      connectorInstanceId: c.connectorInstanceId,
      sourceId: c.sourceId,
      metadata: c.metadata as string | null,
    })),
    {
      threshold: 0.70,
      autoLinkThreshold: 0.85,
      contextFrom: item.context?.from,
      contextSubject: item.context?.sourceSubject,
    },
  );

  // Return top match only if it's above auto-link threshold
  if (matches.length > 0 && isAutoLinkMatch(matches[0].score)) {
    return matches[0];
  }

  return null;
}

function getIngestGuard(sourceId: string): {
  suppressed: boolean;
  linkedTaskId: string | null;
} {
  return runTransaction((tx) => {
    const tombstone = tx.select({ sourceId: taskIngestSuppressions.sourceId })
      .from(taskIngestSuppressions)
      .where(and(
        eq(taskIngestSuppressions.connectorInstanceId, CONNECTOR_INSTANCE_ID),
        eq(taskIngestSuppressions.sourceId, sourceId),
      ))
      .get();
    if (tombstone) return { suppressed: true, linkedTaskId: null };

    const linkedSource = tx.select({ taskId: taskLinkedSources.taskId })
      .from(taskLinkedSources)
      .where(and(
        eq(taskLinkedSources.connectorInstanceId, CONNECTOR_INSTANCE_ID),
        eq(taskLinkedSources.sourceId, sourceId),
      ))
      .get();
    return {
      suppressed: false,
      linkedTaskId: linkedSource?.taskId ?? null,
    };
  }, { readOnly: true });
}

/**
 * Create a linked source record — connects a Scout item to an existing task
 * from another connector instead of creating a duplicate.
 * Uses onConflictDoNothing to prevent duplicate links on re-ingest.
 */
function linkSourceToTask(
  taskId: string,
  item: ScoutIngestItem,
  matchConfidence: number,
): boolean {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const linked = runTransaction((tx) => {
    const tombstone = tx.select({ sourceId: taskIngestSuppressions.sourceId })
      .from(taskIngestSuppressions)
      .where(and(
        eq(taskIngestSuppressions.connectorInstanceId, CONNECTOR_INSTANCE_ID),
        eq(taskIngestSuppressions.sourceId, item.sourceId),
      ))
      .get();
    if (tombstone) return false;

    tx.insert(taskLinkedSources).values({
      id,
      taskId,
      connectorType: 'scout',
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      sourceId: item.sourceId,
      title: item.title,
      linkedAt: now,
      matchConfidence,
      metadata: JSON.stringify({
        sourceType: item.sourceType,
        scoutContext: item.context || null,
        confidence: item.confidence ?? null,
      }),
    }).onConflictDoNothing().run();
    return true;
  });

  if (linked) {
    logger.info(`[scout-ingest] Linked source ${item.sourceId} to existing task ${taskId} (confidence: ${matchConfidence.toFixed(2)})`);
  }
  return linked;
}

/**
 * Ensure the source list for a given source type exists. Creates it if not.
 */
async function ensureSourceList(sourceType: string): Promise<string> {
  const listDef = SOURCE_LIST_MAP[sourceType];
  if (!listDef) return '';

  const [existing] = await db
    .select({ id: sourceLists.id })
    .from(sourceLists)
    .where(eq(sourceLists.sourceId, listDef.id));

  if (existing) return listDef.id;

  // Auto-create source list
  const now = new Date().toISOString();
  await db.insert(sourceLists).values({
    id: `sl-scout-${sourceType}`,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    sourceId: listDef.id,
    name: listDef.name,
    type: listDef.type,
    taskCount: 0,
    lastSyncedAt: now,
    sortOrder: 0,
    hidden: false,
    icon: listDef.icon,
    iconColor: listDef.iconColor,
  }).onConflictDoNothing();

  logger.info(`[scout-ingest] Auto-created source list: ${listDef.name} (${listDef.id})`);
  return listDef.id;
}

/**
 * Build the metadata JSON for a Scout task including provenance.
 */
function buildMetadata(
  item: ScoutIngestItem,
  existingMetadata: unknown,
  now: string,
  taskId?: string,
): string {
  const parsed = parseTaskMetadataCompat(existingMetadata);
  if (parsed.recoveredLegacy) {
    logger.warn({ taskId }, '[scout-ingest] Preserved unstructured legacy metadata during provenance refresh');
  }
  return JSON.stringify(mergeScoutMetadata(parsed.metadata, item, now));
}

function serializeMetadata(metadata: unknown): string {
  return JSON.stringify(parseTaskMetadataCompat(metadata).metadata);
}

function getIncomingFields(item: ScoutIngestItem) {
  return {
    title: item.title,
    description: item.description || null,
    priority: item.priority || 'none',
    dueDate: item.dueDate || null,
  };
}

function shouldRouteToTriage(item: ScoutIngestItem, settings: ScoutConnectorSettings): boolean {
  if (settings.landingMode === 'triage') return true;
  if (settings.landingMode === 'direct') return false;
  const confidence = item.confidence ?? item.context?.confidence ?? 0;
  return confidence < settings.hybridConfidenceThreshold;
}

function getScoutSourceUrl(item: ScoutIngestItem): string {
  const originalSource = item.context?.originalSource;
  const candidate = originalSource?.url ?? originalSource?.webUrl;
  return typeof candidate === 'string' && /^https?:\/\//i.test(candidate)
    ? candidate
    : `scout://item/${encodeURIComponent(item.sourceId)}`;
}

async function routeToTriage(
  item: ScoutIngestItem,
  settings: ScoutConnectorSettings,
  knownExisting?: ExistingTriageItem | null,
  projectValidityCache?: Map<string, boolean>,
): Promise<ScoutIngestResult> {
  const existing = knownExisting === undefined
    ? await findExistingTriageItem(item.sourceId)
    : knownExisting;

  if (existing && (existing.status === 'actioned' || existing.status === 'dismissed')) {
    return createScoutIngestResult({
      sourceId: item.sourceId,
      mcTaskId: null,
      triageItemId: existing.id,
      action: 'suppressed',
      reason: 'triage_closed',
    });
  }

  const now = new Date().toISOString();
  const confidence = item.confidence ?? item.context?.confidence ?? 0;
  const sourceUrl = getScoutSourceUrl(item);
  const effectiveProjectId = await resolveProjectId(
    item.suggestedProjectId,
    settings.autoProjectId,
    projectValidityCache,
  );
  const triageValues = {
    sourceUrl,
    canonicalUrl: sourceUrl,
    title: item.title,
    description: item.description || null,
    contentType: 'text_post',
    capturedAt: item.context?.extractedAt || now,
    aiSummary: item.description || null,
    aiCategories: [item.sourceType, ...(item.suggestedTags || [])],
    aiSuggestedActions: [],
    aiRelevanceScore: Math.round(confidence * 100),
    aiUrgency: item.priority === 'critical' || item.priority === 'high'
      ? 'urgent'
      : item.priority === 'medium'
        ? 'soon'
        : 'evergreen',
    rawMetadata: {
      connectorType: 'scout',
      sourceType: item.sourceType,
      confidence,
      dueDate: item.dueDate || null,
      priority: item.priority || 'none',
      suggestedTags: item.suggestedTags || [],
      suggestedProjectId: item.suggestedProjectId || null,
      effectiveProjectId,
      scoutContext: item.context || null,
    },
  };

  if (existing) {
    await db.update(triageItems)
      .set(triageValues)
      .where(eq(triageItems.id, existing.id));
    await publishSemanticEntityUpsert('triage-item', existing.id);
    return createScoutIngestResult({
      sourceId: item.sourceId,
      mcTaskId: null,
      triageItemId: existing.id,
      action: 'triaged',
      reason: 'triage_updated',
    });
  }

  const id = crypto.randomUUID();
  await db.insert(triageItems).values({
    id,
    sourcePlatform: 'scout',
    sourceId: item.sourceId,
    ...triageValues,
    ingestedAt: now,
    status: 'pending',
    actionsTaken: [],
  }).onConflictDoUpdate({
    target: [triageItems.sourcePlatform, triageItems.sourceId],
    set: triageValues,
    setWhere: notInArray(triageItems.status, ['actioned', 'dismissed']),
  });

  const [stored] = await db
    .select({ id: triageItems.id, status: triageItems.status })
    .from(triageItems)
    .where(
      and(
        eq(triageItems.sourcePlatform, 'scout'),
        eq(triageItems.sourceId, item.sourceId),
      ),
    );
  if (stored && (stored.status === 'actioned' || stored.status === 'dismissed')) {
    return createScoutIngestResult({
      sourceId: item.sourceId,
      mcTaskId: null,
      triageItemId: stored.id,
      action: 'suppressed',
      reason: 'triage_closed',
    });
  }

  await publishSemanticEntityUpsert('triage-item', stored?.id || id);
  return createScoutIngestResult({
    sourceId: item.sourceId,
    mcTaskId: null,
    triageItemId: stored?.id || id,
    action: 'triaged',
    reason: 'landing_mode',
  });
}

async function findExistingTriageItem(sourceId: string): Promise<ExistingTriageItem | null> {
  const [existing] = await db
    .select({ id: triageItems.id, status: triageItems.status })
    .from(triageItems)
    .where(
      and(
        eq(triageItems.sourcePlatform, 'scout'),
        eq(triageItems.sourceId, sourceId),
      ),
    );
  return existing || null;
}

async function resolveProjectId(
  suggestedProjectId: string | undefined,
  configuredProjectId: string | null,
  validityCache?: Map<string, boolean>,
): Promise<string | null> {
  const candidates = [...new Set([suggestedProjectId, configuredProjectId].filter(
    (projectId): projectId is string => !!projectId,
  ))];
  for (const projectId of candidates) {
    if (validityCache?.has(projectId)) {
      if (validityCache.get(projectId)) return projectId;
      continue;
    }
    const [project] = await db
      .select({ id: hubProjects.id })
      .from(hubProjects)
      .where(eq(hubProjects.id, projectId));
    validityCache?.set(projectId, !!project);
    if (project) return project.id;
  }
  return null;
}

/**
 * Resolve tag slugs to tag IDs, creating tags if needed.
 */
function buildScoutTags(slugs: string[]) {
  const now = new Date().toISOString();
  return slugs.flatMap((raw) => {
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return [];
    const tagId = `tag-${slug}`;
    return [{
      id: tagId,
      name: raw,
      slug,
      type: 'hub',
      source: null,
      color: '#6b7280',
      confirmed: true,
      createdAt: now,
    }];
  });
}

/**
 * Ensure the Scout connector config row exists in connector_configs.
 * Without this, Scout won't appear in the sidebar SOURCES list.
 * Returns whether the connector is enabled (rejects ingest when disabled).
 */
async function ensureConnectorConfig(): Promise<{ enabled: boolean; settings: ScoutConnectorSettings }> {
  const [existing] = await db
    .select({
      id: connectorConfigs.id,
      enabled: connectorConfigs.enabled,
      settings: connectorConfigs.settings,
    })
    .from(connectorConfigs)
    .where(eq(connectorConfigs.id, CONNECTOR_INSTANCE_ID));

  if (existing) {
    return {
      enabled: existing.enabled,
      settings: parseScoutSettings(existing.settings, LEGACY_SCOUT_SETTINGS),
    };
  }

  const now = new Date().toISOString();
  await db.insert(connectorConfigs).values({
    id: CONNECTOR_INSTANCE_ID,
    type: 'scout',
    name: 'Scout',
    enabled: true,
    syncMode: 'push',
    pollIntervalMinutes: null,
    capabilities: JSON.stringify({
      read: true,
      write: false,
      delete: false,
      sync: false,
      subtasks: false,
      lists: true,
      tags: true,
      tagWriteBack: false,
      listSelectionMode: 'not-applicable',
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
      pullWriteBackWhenDisabled: true,
    }),
    credentials: JSON.stringify({}),
    settings: DEFAULT_SCOUT_SETTINGS,
    syncedLists: JSON.stringify([]),
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  // Pre-create all source lists so they appear in the sidebar immediately
  for (const [sourceType, listDef] of Object.entries(SOURCE_LIST_MAP)) {
    await db.insert(sourceLists).values({
      id: `sl-scout-${sourceType}`,
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      sourceId: listDef.id,
      name: listDef.name,
      type: listDef.type,
      taskCount: 0,
      lastSyncedAt: now,
      sortOrder: 0,
      hidden: false,
      icon: listDef.icon,
      iconColor: listDef.iconColor,
    }).onConflictDoNothing();
  }

  logger.info('[scout-ingest] Auto-registered Scout connector config with source lists');
  return { enabled: true, settings: DEFAULT_SCOUT_SETTINGS };
}

// ─── POST Handler ───────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    // Auth check
    if (!hasValidApiKey(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { items } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'items array is required and must not be empty' },
        { status: 400 },
      );
    }

    if (items.length > 100) {
      return NextResponse.json(
        { error: 'Maximum 100 items per request' },
        { status: 400 },
      );
    }

    // Validate all items upfront
    const validatedItems: ScoutIngestItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const result = validateItem(items[i], i);
      if (!result.valid) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      validatedItems.push(result.parsed!);
    }

    const results: ScoutIngestResult[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let triaged = 0;
    const projectValidityCache = new Map<string, boolean>();

    // Ensure Scout connector config exists; reject if disabled
    const { enabled, settings } = await ensureConnectorConfig();
    if (!enabled) {
      return NextResponse.json(
        { error: 'Scout connector is disabled. Enable it in Settings > Connectors to accept pushes.' },
        { status: 403 },
      );
    }

    // Fetch cross-connector candidates ONCE for the entire batch (performance: avoids N+1)
    const crossConnectorCandidates = await fetchCrossConnectorCandidates();

    const ingestQueue = [...validatedItems];
    const concurrentRetries = new Set<string>();
    for (const item of ingestQueue) {
      if (!settings.allowedSourceTypes.includes(item.sourceType)) {
        results.push(createScoutIngestResult({
          sourceId: item.sourceId,
          mcTaskId: null,
          action: 'skipped',
          reason: 'source_type_disabled',
        }));
        skipped++;
        continue;
      }
      // Check for existing task (deduplication)
      const existing = await findExistingTask(item.sourceId);

      if (existing) {
        const now = new Date().toISOString();
        const incomingFields = getIncomingFields(item);
        const mergeResult = runTransaction((tx) => {
          const current = tx
            .select({
              id: tasks.id,
              title: tasks.title,
              description: tasks.description,
              priority: tasks.priority,
              dueDate: tasks.dueDate,
              metadata: tasks.metadata,
              status: tasks.status,
              snoozedUntil: tasks.snoozedUntil,
            })
            .from(tasks)
            .where(eq(tasks.id, existing.id))
            .get();
          if (!current) {
            return { observations: [], reportChanged: false, reason: 'task_missing' as const };
          }
          if (current.status === 'done' || current.status === 'cancelled') {
            return { observations: [], reportChanged: false, reason: 'task_closed' as const };
          }
          if (current.snoozedUntil && new Date(current.snoozedUntil) > new Date()) {
            return { observations: [], reportChanged: false, reason: 'snoozed' as const };
          }

          const mergedMetadata = buildMetadata(item, current.metadata, now, current.id);
          const currentMetadata = serializeMetadata(current.metadata);
          const stateRows = tx
            .select()
            .from(taskFieldStates)
            .where(eq(taskFieldStates.taskId, existing.id))
            .all() as TaskFieldStateRecord[];
          const statesByField = new Map(stateRows.map((state) => [state.fieldName, state]));
          const titleObservation = resolveInboundSourceObservation({
            fieldName: 'title',
            incomingValue: incomingFields.title,
            currentValue: current.title,
            state: statesByField.get('title'),
            now,
          });
          const descriptionObservation = resolveInboundSourceObservation({
            fieldName: 'description',
            incomingValue: incomingFields.description,
            currentValue: current.description,
            state: statesByField.get('description'),
            now,
          });
          const priorityObservation = resolveInboundSourceObservation({
            fieldName: 'priority',
            incomingValue: incomingFields.priority,
            currentValue: current.priority,
            state: statesByField.get('priority'),
            now,
          });
          const dueDateObservation = resolveInboundSourceObservation({
            fieldName: 'dueDate',
            incomingValue: incomingFields.dueDate,
            currentValue: current.dueDate,
            state: statesByField.get('dueDate'),
            now,
          });
          const observations = [
            titleObservation,
            descriptionObservation,
            priorityObservation,
            dueDateObservation,
          ];
          const renderedChanged = observations.some(
            (entry) => serializeTaskFieldValue(entry.renderedValue)
              !== serializeTaskFieldValue(current[entry.fieldName]),
          );
          const sourceStateChanged = observations.some(
            (entry) => entry.sourceValue !== statesByField.get(entry.fieldName)?.sourceValue
              || entry.locallyOverridden
                !== (statesByField.get(entry.fieldName)?.locallyOverridden ?? false),
          );
          const observedSourceChanged = observations.some((entry) => {
            const priorState = statesByField.get(entry.fieldName);
            return priorState !== undefined && (
              entry.sourceValue !== priorState.sourceValue
              || entry.locallyOverridden !== priorState.locallyOverridden
            );
          });
          const metadataChanged = mergedMetadata !== currentMetadata;
          const taskChanged = renderedChanged || sourceStateChanged || metadataChanged;

          if (taskChanged) {
            const renderedUpdates: {
              title?: string;
              description?: string | null;
              priority?: string;
              dueDate?: string | null;
            } = {};
            for (const observation of observations) {
              if (observation.action === 'preserved') continue;
              switch (observation.fieldName) {
                case 'title':
                  if (observation.renderedValue === null) {
                    throw new TypeError('Scout title cannot be null');
                  }
                  renderedUpdates.title = observation.renderedValue;
                  break;
                case 'description':
                  renderedUpdates.description = observation.renderedValue;
                  break;
                case 'priority':
                  if (observation.renderedValue === null) {
                    throw new TypeError('Scout priority cannot be null');
                  }
                  renderedUpdates.priority = observation.renderedValue;
                  break;
                case 'dueDate':
                  renderedUpdates.dueDate = observation.renderedValue;
                  break;
              }
            }
            tx.update(tasks)
              .set({
                ...renderedUpdates,
                metadata: mergedMetadata,
                updatedAt: now,
                lastSyncedAt: now,
              })
              .where(eq(tasks.id, existing.id))
              .run();
          }

          for (const observation of observations) {
            tx.insert(taskFieldStates).values({
              taskId: existing.id,
              fieldName: observation.fieldName,
              sourceValue: observation.sourceValue,
              locallyOverridden: observation.locallyOverridden,
              sourceObservedAt: observation.sourceObservedAt,
              localEditedAt: observation.localEditedAt,
              updatedAt: observation.updatedAt,
            }).onConflictDoUpdate({
              target: [taskFieldStates.taskId, taskFieldStates.fieldName],
              set: {
                sourceValue: observation.sourceValue,
                locallyOverridden: observation.locallyOverridden,
                sourceObservedAt: observation.sourceObservedAt,
                localEditedAt: observation.localEditedAt,
                updatedAt: observation.updatedAt,
              },
            }).run();
          }
          return {
            observations,
            reportChanged: renderedChanged || observedSourceChanged || metadataChanged,
            reason: null,
          };
        });
        const appliedFields = mergeResult.observations
          .filter((entry) => entry.action === 'applied' || entry.action === 'cleared')
          .map((entry) => entry.fieldName);
        const preservedOverrides = mergeResult.observations
          .filter((entry) => entry.action === 'preserved')
          .map((entry) => entry.fieldName);
        const unchangedFields = mergeResult.observations
          .filter((entry) => entry.action === 'unchanged')
          .map((entry) => entry.fieldName);
        logger.info({
          taskId: existing.id,
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          appliedFields,
          preservedOverrides,
          unchangedFields,
        }, '[scout-ingest] Recorded inbound source field observations');

        if (mergeResult.reason) {
          results.push(createScoutIngestResult({
            sourceId: item.sourceId,
            mcTaskId: existing.id,
            action: mergeResult.reason === 'task_missing' ? 'skipped' : 'suppressed',
            reason: mergeResult.reason,
          }));
          skipped++;
        } else {
          results.push(createScoutIngestResult({
            sourceId: item.sourceId,
            mcTaskId: existing.id,
            action: mergeResult.reportChanged ? 'updated' : 'skipped',
            ...(mergeResult.reportChanged ? {} : { reason: 'unchanged' }),
            appliedFields,
            preservedOverrides,
            unchangedFields,
          }));
          if (mergeResult.reportChanged) updated++;
          else skipped++;
        }
      } else {
        const ingestGuard = getIngestGuard(item.sourceId);
        if (ingestGuard.suppressed) {
          results.push(createScoutIngestResult({
            sourceId: item.sourceId,
            mcTaskId: null,
            action: 'suppressed',
            reason: 'ingest_tombstone',
          }));
          skipped++;
          continue;
        }
        if (ingestGuard.linkedTaskId) {
          results.push(createScoutIngestResult({
            sourceId: item.sourceId,
            mcTaskId: ingestGuard.linkedTaskId,
            action: 'linked',
            reason: 'existing_link',
            linkedTo: ingestGuard.linkedTaskId,
          }));
          skipped++;
          continue;
        }
        const existingTriageItem = await findExistingTriageItem(item.sourceId);
        if (existingTriageItem) {
          const triageResult = await routeToTriage(
            item,
            settings,
            existingTriageItem,
            projectValidityCache,
          );
          results.push(triageResult);
          if (triageResult.action === 'triaged') triaged++;
          else skipped++;
          continue;
        }

        if (shouldRouteToTriage(item, settings)) {
          const triageResult = await routeToTriage(
            item,
            settings,
            null,
            projectValidityCache,
          );
          results.push(triageResult);
          if (triageResult.action === 'triaged') triaged++;
          else skipped++;
          continue;
        }

        // Cross-connector dedup: check if this item matches an existing task from another connector
        const crossMatch = findCrossConnectorMatch(item, crossConnectorCandidates);

        if (crossMatch) {
          // Link to existing task instead of creating a duplicate
          const linked = linkSourceToTask(crossMatch.taskId, item, crossMatch.score);
          results.push(createScoutIngestResult(linked
            ? {
                sourceId: item.sourceId,
                mcTaskId: crossMatch.taskId,
                action: 'linked',
                reason: `matched_${crossMatch.connectorType}`,
                linkedTo: crossMatch.taskId,
              }
            : {
                sourceId: item.sourceId,
                mcTaskId: null,
                action: 'suppressed',
                reason: 'ingest_tombstone',
              }));
          skipped++;
          continue;
        }

        // Create new task
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const sourceListId = await ensureSourceList(item.sourceType);
        const sourceListName = SOURCE_LIST_MAP[item.sourceType]?.name || null;
        const scoutTags = buildScoutTags(item.suggestedTags ?? []);
        const projectId = await resolveProjectId(
          item.suggestedProjectId,
          settings.autoProjectId,
          projectValidityCache,
        );

        const initialSourceFields = {
          title: item.title,
          description: item.description || null,
          priority: item.priority || 'none',
          dueDate: item.dueDate || null,
        };
        const creationResult = runTransaction((tx) => {
          const tombstone = tx.select({ sourceId: taskIngestSuppressions.sourceId })
            .from(taskIngestSuppressions)
            .where(and(
              eq(taskIngestSuppressions.connectorInstanceId, CONNECTOR_INSTANCE_ID),
              eq(taskIngestSuppressions.sourceId, item.sourceId),
            ))
            .get();
          if (tombstone) return { kind: 'suppressed' } as const;

          const insertion = tx.insert(tasks).values({
            id,
            sourceId: item.sourceId,
            connectorType: 'scout',
            connectorInstanceId: CONNECTOR_INSTANCE_ID,
            title: initialSourceFields.title,
            description: initialSourceFields.description,
            status: 'todo',
            priority: initialSourceFields.priority,
            dueDate: initialSourceFields.dueDate,
            createdAt: now,
            updatedAt: now,
            depth: 0,
            isChecklistItem: false,
            sourceListId,
            sourceListName,
            syncStatus: 'synced',
            lastSyncedAt: now,
            metadata: buildMetadata(item, {}, now),
          }).onConflictDoNothing({
            target: [tasks.sourceId, tasks.connectorInstanceId],
          }).run();
          if (insertion.changes === 0) {
            const winner = tx.select({ id: tasks.id })
              .from(tasks)
              .where(and(
                eq(tasks.connectorInstanceId, CONNECTOR_INSTANCE_ID),
                eq(tasks.sourceId, item.sourceId),
              ))
              .get();
            if (!winner) {
              throw new Error(`Scout ingest conflict for ${item.sourceId} had no winning task`);
            }
            return { kind: 'existing', taskId: winner.id } as const;
          }
          tx.insert(taskFieldStates).values(
            Object.entries(initialSourceFields).map(([fieldName, value]) => ({
              taskId: id,
              fieldName,
              sourceValue: serializeTaskFieldValue(value),
              locallyOverridden: false,
              sourceObservedAt: now,
              localEditedAt: null,
              updatedAt: now,
            })),
          ).run();
          if (scoutTags.length > 0) {
            tx.insert(tags).values(scoutTags).onConflictDoNothing().run();
            tx.insert(taskTags).values(
              scoutTags.map((tag) => ({ taskId: id, tagId: tag.id })),
            ).run();
          }
          if (projectId) {
            tx.insert(taskProjects).values({ taskId: id, projectId }).run();
          }
          return { kind: 'created' } as const;
        });
        if (creationResult.kind === 'suppressed') {
          results.push(createScoutIngestResult({
            sourceId: item.sourceId,
            mcTaskId: null,
            action: 'suppressed',
            reason: 'ingest_tombstone',
          }));
          skipped++;
          continue;
        }
        if (creationResult.kind === 'existing') {
          if (concurrentRetries.has(item.sourceId)) {
            throw new Error(`Scout ingest conflict for ${item.sourceId} did not converge`);
          }
          concurrentRetries.add(item.sourceId);
          ingestQueue.push(item);
          continue;
        }
        logger.info(
          { taskId: id, connectorInstanceId: CONNECTOR_INSTANCE_ID, fields: Object.keys(initialSourceFields) },
          '[scout-ingest] Recorded initial source field observations',
        );

        // Emit event for real-time UI updates
        emitEvent({
          type: 'task.created',
          timestamp: new Date().toISOString(),
          payload: { id, title: item.title, connectorType: 'scout' },
        });

        results.push(createScoutIngestResult({
          sourceId: item.sourceId,
          mcTaskId: id,
          action: 'created',
          appliedFields: [...MERGEABLE_TASK_FIELDS],
        }));
        created++;
      }
    }

    // Update source list task counts
    const affectedSourceTypes = [...new Set(validatedItems.map(i => i.sourceType))];
    for (const sourceType of affectedSourceTypes) {
      const listDef = SOURCE_LIST_MAP[sourceType];
      if (!listDef) continue;

      const countResult = db
        .select({ count: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.connectorType, 'scout'),
            eq(tasks.sourceListId, listDef.id),
          )
        )
        .all();

      await db.update(sourceLists)
        .set({
          taskCount: countResult.length,
          lastSyncedAt: new Date().toISOString(),
        })
        .where(eq(sourceLists.sourceId, listDef.id));
    }

    logger.info(`[scout-ingest] Processed ${validatedItems.length} items: ${created} created, ${updated} updated, ${triaged} triaged, ${skipped} skipped`);

    return NextResponse.json({
      created,
      updated,
      triaged,
      skipped,
      total: validatedItems.length,
      items: results,
    });
  } catch (err) {
    logger.error('[scout-ingest] Error processing ingest request: %s', err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
