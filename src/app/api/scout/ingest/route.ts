import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  ScoutCrossConnectorCandidate,
  ScoutFieldObservationWrite,
  ScoutIngestionRepository,
  ScoutSourceListDefinition,
  ScoutTagInsert,
  ScoutTaskMergeDecision,
} from '@/db/persistence/scout-ingestion-reconciliation';
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
  type InboundSourceObservation,
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

// ─── Source List Definitions ────────────────────────────────────────────────

const SOURCE_LIST_MAP: Record<string, ScoutSourceListDefinition> = {
  email: { id: 'sl-scout-email', sourceId: 'scout:email-actions', name: 'Email Actions', type: 'folder', icon: 'mdi:email-outline', iconColor: '#0078d4' },
  teams: { id: 'sl-scout-teams', sourceId: 'scout:teams-actions', name: 'Teams Actions', type: 'folder', icon: 'mdi:microsoft-teams', iconColor: '#6264a7' },
  meeting: { id: 'sl-scout-meeting', sourceId: 'scout:meeting-actions', name: 'Meeting Follow-ups', type: 'folder', icon: 'mdi:calendar-clock', iconColor: '#0f6cbd' },
  planner: { id: 'sl-scout-planner', sourceId: 'scout:planner-sync', name: 'Planner Tasks', type: 'list', icon: 'mdi:clipboard-check-outline', iconColor: '#31752f' },
  'cross-source': { id: 'sl-scout-cross-source', sourceId: 'scout:cross-source', name: 'Cross-Source Items', type: 'folder', icon: 'lucide:workflow', iconColor: '#8b5cf6' },
};

const CONNECTOR_INSTANCE_ID = 'scout-primary';
const CONNECTOR_TYPE = 'scout';
const TRIAGE_SOURCE_PLATFORM = 'scout';
const CLOSED_TASK_STATUSES = ['done', 'cancelled'] as const;
/** Maximum number of items a single Scout push may carry. */
const MAX_ITEMS_PER_REQUEST = 100;

const VALID_SOURCE_TYPES = ['email', 'teams', 'meeting', 'planner', 'cross-source'] as const;
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

const SCOUT_CONNECTOR_DEFAULTS = {
  type: CONNECTOR_TYPE,
  name: 'Scout',
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
  settings: JSON.stringify(DEFAULT_SCOUT_SETTINGS),
  syncedLists: JSON.stringify([]),
} as const;

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
 * Search for existing tasks from OTHER connectors that might match this Scout
 * item, using the single batch-wide candidate snapshot.
 */
function findCrossConnectorMatch(
  item: ScoutIngestItem,
  candidates: readonly ScoutCrossConnectorCandidate[],
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
      metadata: typeof c.metadata === 'string'
        ? c.metadata
        : c.metadata == null
          ? null
          : JSON.stringify(c.metadata),
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

/** Resolve tag slugs to tag rows, creating tags if needed. */
function buildScoutTags(slugs: readonly string[], now: string): ScoutTagInsert[] {
  return slugs.flatMap((raw) => {
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return [];
    return [{
      id: `tag-${slug}`,
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

    if (items.length > MAX_ITEMS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Maximum ${MAX_ITEMS_PER_REQUEST} items per request` },
        { status: 400 },
      );
    }

    // Validate the full request before any persistence happens.
    const validatedItems: ScoutIngestItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const result = validateItem(items[i], i);
      if (!result.valid) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      validatedItems.push(result.parsed!);
    }

    const repositories = await getWorkerPersistenceRepositories();
    const scout = repositories.scoutIngestionReconciliation;
    if (!scout) {
      return NextResponse.json(
        { error: 'Scout ingestion persistence is not available in the selected backend' },
        { status: 503 },
      );
    }
    const ingestion: ScoutIngestionRepository = scout.ingestion;

    const results: ScoutIngestResult[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let triaged = 0;
    const projectValidityCache = new Map<string, boolean>();
    const ensuredSourceLists = new Set<string>();

    async function resolveProjectId(
      suggestedProjectId: string | undefined,
      configuredProjectId: string | null,
    ): Promise<string | null> {
      const candidates = [...new Set([suggestedProjectId, configuredProjectId].filter(
        (projectId): projectId is string => !!projectId,
      ))];
      const unknown = candidates.filter((projectId) => !projectValidityCache.has(projectId));
      if (unknown.length > 0) {
        const present = new Set(await ingestion.filterExistingProjectIds(unknown));
        for (const projectId of unknown) {
          projectValidityCache.set(projectId, present.has(projectId));
        }
      }
      return candidates.find((projectId) => projectValidityCache.get(projectId) === true)
        ?? null;
    }

    async function ensureSourceList(sourceType: string): Promise<string> {
      const definition = SOURCE_LIST_MAP[sourceType];
      if (!definition) return '';
      if (ensuredSourceLists.has(sourceType)) return definition.sourceId;
      const outcome = await ingestion.ensureSourceList({
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        definition,
        now: new Date().toISOString(),
      });
      if (outcome.created) {
        logger.info(
          `[scout-ingest] Auto-created source list: ${definition.name} (${definition.sourceId})`,
        );
      }
      ensuredSourceLists.add(sourceType);
      return definition.sourceId;
    }

    async function routeToTriage(
      item: ScoutIngestItem,
      settings: ScoutConnectorSettings,
      knownExisting: { id: string; status: string } | null,
    ): Promise<ScoutIngestResult> {
      if (
        knownExisting
        && (knownExisting.status === 'actioned' || knownExisting.status === 'dismissed')
      ) {
        return createScoutIngestResult({
          sourceId: item.sourceId,
          mcTaskId: null,
          triageItemId: knownExisting.id,
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
      );
      const outcome = await ingestion.upsertTriageItem({
        triageItemId: crypto.randomUUID(),
        sourcePlatform: TRIAGE_SOURCE_PLATFORM,
        sourceId: item.sourceId,
        ingestedAt: now,
        values: {
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
            connectorType: CONNECTOR_TYPE,
            sourceType: item.sourceType,
            confidence,
            dueDate: item.dueDate || null,
            priority: item.priority || 'none',
            suggestedTags: item.suggestedTags || [],
            suggestedProjectId: item.suggestedProjectId || null,
            effectiveProjectId,
            scoutContext: item.context || null,
          },
        },
      });

      if (outcome.kind === 'closed') {
        return createScoutIngestResult({
          sourceId: item.sourceId,
          mcTaskId: null,
          triageItemId: outcome.triageItemId,
          action: 'suppressed',
          reason: 'triage_closed',
        });
      }

      // External side effect: publish only after the row is committed.
      await publishSemanticEntityUpsert('triage-item', outcome.triageItemId);
      return createScoutIngestResult({
        sourceId: item.sourceId,
        mcTaskId: null,
        triageItemId: outcome.triageItemId,
        action: 'triaged',
        reason: outcome.kind === 'updated' ? 'triage_updated' : 'landing_mode',
      });
    }

    // Bootstrap the Scout connector exactly once; reject if disabled.
    const bootstrap = await ingestion.bootstrapConnector({
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      now: new Date().toISOString(),
      defaults: SCOUT_CONNECTOR_DEFAULTS,
      sourceLists: Object.values(SOURCE_LIST_MAP),
    });
    if (!bootstrap.existed) {
      logger.info('[scout-ingest] Auto-registered Scout connector config with source lists');
      for (const sourceType of Object.keys(SOURCE_LIST_MAP)) {
        ensuredSourceLists.add(sourceType);
      }
    }
    const settings = bootstrap.existed
      ? parseScoutSettings(bootstrap.settings, LEGACY_SCOUT_SETTINGS)
      : DEFAULT_SCOUT_SETTINGS;
    if (!bootstrap.enabled) {
      return NextResponse.json(
        { error: 'Scout connector is disabled. Enable it in Settings > Connectors to accept pushes.' },
        { status: 403 },
      );
    }

    // Snapshot cross-connector candidates ONCE for the entire batch.
    const crossConnectorCandidates = await ingestion.listCrossConnectorCandidates({
      excludeConnectorType: CONNECTOR_TYPE,
      closedStatuses: [...CLOSED_TASK_STATUSES],
    });

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
      const existing = await ingestion.findExistingTask({
        connectorType: CONNECTOR_TYPE,
        sourceId: item.sourceId,
      });

      if (existing) {
        const now = new Date().toISOString();
        const incomingFields = getIncomingFields(item);
        let observations: InboundSourceObservation[] = [];
        let reportChanged = false;

        const decision: ScoutTaskMergeDecision = await ingestion.mergeExistingTask({
          taskId: existing.id,
          decide: (snapshot) => {
            observations = [];
            reportChanged = false;
            const current = snapshot.task;
            if (!current) return { kind: 'skip', reason: 'task_missing' };
            if (current.status === 'done' || current.status === 'cancelled') {
              return { kind: 'skip', reason: 'task_closed' };
            }
            if (current.snoozedUntil && new Date(current.snoozedUntil) > new Date()) {
              return { kind: 'skip', reason: 'snoozed' };
            }

            const mergedMetadata = buildMetadata(item, current.metadata, now, current.id);
            const currentMetadata = serializeMetadata(current.metadata);
            const statesByField = new Map(
              (snapshot.fieldStates as readonly TaskFieldStateRecord[])
                .map((state) => [state.fieldName, state]),
            );
            const resolved: InboundSourceObservation[] = [
              resolveInboundSourceObservation({
                fieldName: 'title',
                incomingValue: incomingFields.title,
                currentValue: current.title,
                state: statesByField.get('title'),
                now,
              }),
              resolveInboundSourceObservation({
                fieldName: 'description',
                incomingValue: incomingFields.description,
                currentValue: current.description,
                state: statesByField.get('description'),
                now,
              }),
              resolveInboundSourceObservation({
                fieldName: 'priority',
                incomingValue: incomingFields.priority,
                currentValue: current.priority,
                state: statesByField.get('priority'),
                now,
              }),
              resolveInboundSourceObservation({
                fieldName: 'dueDate',
                incomingValue: incomingFields.dueDate,
                currentValue: current.dueDate,
                state: statesByField.get('dueDate'),
                now,
              }),
            ];
            observations = resolved;

            const currentValues: Record<string, unknown> = {
              title: current.title,
              description: current.description,
              priority: current.priority,
              dueDate: current.dueDate,
            };
            const renderedChanged = resolved.some(
              (entry) => serializeTaskFieldValue(entry.renderedValue)
                !== serializeTaskFieldValue(currentValues[entry.fieldName]),
            );
            const sourceStateChanged = resolved.some(
              (entry) => entry.sourceValue !== statesByField.get(entry.fieldName)?.sourceValue
                || entry.locallyOverridden
                  !== (statesByField.get(entry.fieldName)?.locallyOverridden ?? false),
            );
            const observedSourceChanged = resolved.some((entry) => {
              const priorState = statesByField.get(entry.fieldName);
              return priorState !== undefined && (
                entry.sourceValue !== priorState.sourceValue
                || entry.locallyOverridden !== priorState.locallyOverridden
              );
            });
            const metadataChanged = mergedMetadata !== currentMetadata;
            const taskChanged = renderedChanged || sourceStateChanged || metadataChanged;
            reportChanged = renderedChanged || observedSourceChanged || metadataChanged;

            const rendered: {
              title?: string;
              description?: string | null;
              priority?: string;
              dueDate?: string | null;
            } = {};
            for (const observation of resolved) {
              if (observation.action === 'preserved') continue;
              switch (observation.fieldName) {
                case 'title':
                  if (observation.renderedValue === null) {
                    throw new TypeError('Scout title cannot be null');
                  }
                  rendered.title = observation.renderedValue as string;
                  break;
                case 'description':
                  rendered.description = observation.renderedValue as string | null;
                  break;
                case 'priority':
                  if (observation.renderedValue === null) {
                    throw new TypeError('Scout priority cannot be null');
                  }
                  rendered.priority = observation.renderedValue as string;
                  break;
                case 'dueDate':
                  rendered.dueDate = observation.renderedValue as string | null;
                  break;
              }
            }

            const observationWrites: ScoutFieldObservationWrite[] = resolved.map(
              (observation) => ({
                fieldName: observation.fieldName,
                sourceValue: observation.sourceValue,
                locallyOverridden: observation.locallyOverridden,
                sourceObservedAt: observation.sourceObservedAt,
                localEditedAt: observation.localEditedAt,
                updatedAt: observation.updatedAt,
              }),
            );

            return {
              kind: 'apply',
              observations: observationWrites,
              taskWrite: taskChanged
                ? { rendered, metadata: mergedMetadata, updatedAt: now, lastSyncedAt: now }
                : null,
            };
          },
        });

        const appliedFields = observations
          .filter((entry) => entry.action === 'applied' || entry.action === 'cleared')
          .map((entry) => entry.fieldName);
        const preservedOverrides = observations
          .filter((entry) => entry.action === 'preserved')
          .map((entry) => entry.fieldName);
        const unchangedFields = observations
          .filter((entry) => entry.action === 'unchanged')
          .map((entry) => entry.fieldName);
        logger.info({
          taskId: existing.id,
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          appliedFields,
          preservedOverrides,
          unchangedFields,
        }, '[scout-ingest] Recorded inbound source field observations');

        if (decision.kind === 'skip') {
          results.push(createScoutIngestResult({
            sourceId: item.sourceId,
            mcTaskId: existing.id,
            action: decision.reason === 'task_missing' ? 'skipped' : 'suppressed',
            reason: decision.reason,
          }));
          skipped++;
        } else {
          results.push(createScoutIngestResult({
            sourceId: item.sourceId,
            mcTaskId: existing.id,
            action: reportChanged ? 'updated' : 'skipped',
            ...(reportChanged ? {} : { reason: 'unchanged' }),
            appliedFields,
            preservedOverrides,
            unchangedFields,
          }));
          if (reportChanged) updated++;
          else skipped++;
        }
      } else {
        const ingestGuard = await ingestion.readIngestGuard({
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          sourceId: item.sourceId,
        });
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
        const existingTriageItem = await ingestion.findTriageItem({
          sourcePlatform: TRIAGE_SOURCE_PLATFORM,
          sourceId: item.sourceId,
        });
        if (existingTriageItem) {
          const triageResult = await routeToTriage(item, settings, existingTriageItem);
          results.push(triageResult);
          if (triageResult.action === 'triaged') triaged++;
          else skipped++;
          continue;
        }

        if (shouldRouteToTriage(item, settings)) {
          const triageResult = await routeToTriage(item, settings, null);
          results.push(triageResult);
          if (triageResult.action === 'triaged') triaged++;
          else skipped++;
          continue;
        }

        // Cross-connector dedup: link instead of creating a duplicate.
        const crossMatch = findCrossConnectorMatch(item, crossConnectorCandidates);

        if (crossMatch) {
          const linkOutcome = await ingestion.linkSourceToTask({
            id: crypto.randomUUID(),
            taskId: crossMatch.taskId,
            connectorType: CONNECTOR_TYPE,
            connectorInstanceId: CONNECTOR_INSTANCE_ID,
            sourceId: item.sourceId,
            title: item.title,
            linkedAt: new Date().toISOString(),
            matchConfidence: crossMatch.score,
            metadata: JSON.stringify({
              sourceType: item.sourceType,
              scoutContext: item.context || null,
              confidence: item.confidence ?? null,
            }),
          });
          if (linkOutcome.kind === 'linked') {
            logger.info(`[scout-ingest] Linked source ${item.sourceId} to existing task ${crossMatch.taskId} (confidence: ${crossMatch.score.toFixed(2)})`);
          }
          results.push(createScoutIngestResult(linkOutcome.kind === 'linked'
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
        const scoutTags = buildScoutTags(item.suggestedTags ?? [], now);
        const projectId = await resolveProjectId(
          item.suggestedProjectId,
          settings.autoProjectId,
        );

        const initialSourceFields = {
          title: item.title,
          description: item.description || null,
          priority: item.priority || 'none',
          dueDate: item.dueDate || null,
        };
        const creationResult = await ingestion.createTask({
          connectorInstanceId: CONNECTOR_INSTANCE_ID,
          connectorType: CONNECTOR_TYPE,
          taskId: id,
          sourceId: item.sourceId,
          title: initialSourceFields.title,
          description: initialSourceFields.description,
          status: 'todo',
          priority: initialSourceFields.priority,
          dueDate: initialSourceFields.dueDate,
          sourceListId,
          sourceListName,
          metadata: buildMetadata(item, {}, now),
          now,
          fieldStates: Object.entries(initialSourceFields).map(([fieldName, value]) => ({
            fieldName,
            sourceValue: serializeTaskFieldValue(value),
            locallyOverridden: false,
            sourceObservedAt: now,
            localEditedAt: null,
            updatedAt: now,
          })),
          tags: scoutTags,
          projectId,
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
        if (creationResult.kind === 'conflict') {
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

        // External side effect: emitted only after the item transaction commits.
        await emitEvent({
          type: 'task.created',
          timestamp: new Date().toISOString(),
          payload: { id, title: item.title, connectorType: CONNECTOR_TYPE },
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
    const syncedAt = new Date().toISOString();
    await ingestion.refreshSourceListCounts(
      affectedSourceTypes.flatMap((sourceType) => {
        const definition = SOURCE_LIST_MAP[sourceType];
        return definition
          ? [{
              connectorType: CONNECTOR_TYPE,
              sourceListId: definition.sourceId,
              syncedAt,
            }]
          : [];
      }),
    );

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
