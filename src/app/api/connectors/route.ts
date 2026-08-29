import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { connectorConfigs, financeAccounts, financeAttributionAudit, financeAttributionExceptions, financeAttributionSubjects, financeBudgetSnapshots, financeCategories, financeCategoryGroups, financeDatasetSyncState, financeInsightCutovers, financeInsightOccurrenceCacheState, financeInsightOccurrences, financeInsightPublicationFacts, financeInsightPublications, financeInsightPublicationState, financeInsightTransactionBackfillPlans, financeInsightTransactionProjectionFacts, financeInsightTransactionProjectionState, financeInsightTransactionProjectionWindows, financeInsightTransactionWindowProofs, financeMutationAudit, financeRecurringObligations, financeSyncState, financeTags, financeTransactions, focusItems, hubProjects, myDayItems, notificationPushRules, projectAutoIncludeExclusions, projectPhaseItems, sourceLists, syncLog, taskProjects, taskSchedules, taskTags, tasks, workTodoBridgeState, workTodoListDeltaState, workTodoOutboundChanges } from '@/db/schema';
import { eq, sql, and, isNull, inArray, notInArray } from 'drizzle-orm';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import { dbLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { CAPABILITY_DEFAULTS } from '@/lib/connectors/capabilities';
import {
  DEFAULT_SCOUT_SETTINGS,
  validateScoutSettings,
} from '@/lib/connectors/scout/settings';
import { syncScheduler } from '@/lib/sync';
import {
  ConnectorOperationBusyError,
  runWithConnectorOperationLease,
} from '@/lib/sync/connector-lock';
import {
  capabilitiesForWorkTodo,
  workTodoSettingsSchema,
} from '@/lib/connectors/work-todo/settings';
import { createNewGitHubConnectorIdentityState } from '@/lib/external-identities';
import { normalizeGitHubOrigin } from '@/lib/connectors/github-issues/identity';
import {
  FinanceConnectorConfigurationError,
  isFinanceConnectorType,
  preserveFinanceConnectorIdentityCredentials,
  protectNewFinanceConnectorCredentials,
  sanitizeFinanceConnectorWrite,
  validateFinanceConnectorSettings,
} from '@/lib/connectors/monarch-money/config';
import { TyrionBridgeUrlValidationError } from '@/lib/connectors/monarch-money/bridge-url';
import { serializeConnectorForBrowser } from '@/lib/connectors/public-config';
import { isSourceListSelected } from '@/lib/connectors/source-list-selection';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const includeDeleted = searchParams.get('includeDeleted') === 'true';

  try {
    const configs = await db.select().from(connectorConfigs)
      .where(includeDeleted ? undefined : isNull(connectorConfigs.deletedAt));
    let lists = await db.select().from(sourceLists);

    // Auto-ensure Scout source lists exist if Scout connector is configured
    const scoutConfig = configs.find(c => c.type === 'scout' && !c.deletedAt);
    if (scoutConfig) {
      const scoutListIds = new Set(
        lists.filter(sl => sl.connectorInstanceId === scoutConfig.id).map(sl => sl.sourceId)
      );
      const missingLists = Object.entries(SCOUT_SOURCE_LISTS).filter(
        ([, def]) => !scoutListIds.has(def.id)
      );
      if (missingLists.length > 0) {
        const now = new Date().toISOString();
        for (const [sourceType, listDef] of missingLists) {
          await db.insert(sourceLists).values({
            id: `sl-scout-${sourceType}`,
            connectorInstanceId: scoutConfig.id,
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
        // Re-fetch lists after creation
        lists = await db.select().from(sourceLists);
      }
    }

    // Compute top-level open task counts per source list.
    const taskCounts = await db
      .select({
        sourceListId: tasks.sourceListId,
        connectorInstanceId: tasks.connectorInstanceId,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(tasks)
      .where(and(
        notInArray(tasks.status, ['done', 'cancelled']),
        isNull(tasks.parentId),
        eq(tasks.isChecklistItem, false),
      ))
      .groupBy(tasks.sourceListId, tasks.connectorInstanceId);

    const countMap = new Map(
      taskCounts.map(tc => [`${tc.connectorInstanceId}:${tc.sourceListId}`, tc.count])
    );

    // Enrich lists with real task counts and resolved display name
    const configById = new Map(configs.map(config => [config.id, config]));
    const enrichedLists = lists.map(sl => {
      const connector = configById.get(sl.connectorInstanceId);
      return {
        ...sl,
        name: resolveSourceListDisplayName(sl),
        taskCount: countMap.get(`${sl.connectorInstanceId}:${sl.sourceId}`) || 0,
        selectedForSync: connector ? isSourceListSelected(connector, sl) : false,
      };
    });

    // Get last successful sync time per connector
    const lastSyncs = await db
      .select({
        connectorId: syncLog.connectorId,
        syncedAt: sql<string>`max(${syncLog.syncedAt})`.as('synced_at'),
      })
      .from(syncLog)
      .where(eq(syncLog.success, true))
      .groupBy(syncLog.connectorId);

    const lastSyncMap = new Map(
      lastSyncs.map((row) => [row.connectorId, row.syncedAt]),
    );

    // Merge lastSyncedAt and capability defaults into connector configs
    const connectors = configs.map(c => {
      const defaults = CAPABILITY_DEFAULTS[c.type] ?? {};
      const storedCaps = (c.capabilities ?? {}) as Record<string, unknown>;
      return serializeConnectorForBrowser({
        ...c,
        capabilities: { ...defaults, ...storedCaps },
        lastSyncedAt: lastSyncMap.get(c.id) || null,
      });
    });

    return NextResponse.json({ connectors, sourceLists: enrichedLists });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch connectors', error);
  }
}

// Scout source list definitions (shared with ingest route)
const SCOUT_SOURCE_LISTS: Record<string, { id: string; name: string; type: string; icon: string; iconColor: string }> = {
  email: { id: 'scout:email-actions', name: 'Email Actions', type: 'folder', icon: 'mdi:email-outline', iconColor: '#0078d4' },
  teams: { id: 'scout:teams-actions', name: 'Teams Actions', type: 'folder', icon: 'mdi:microsoft-teams', iconColor: '#6264a7' },
  meeting: { id: 'scout:meeting-actions', name: 'Meeting Follow-ups', type: 'folder', icon: 'mdi:calendar-clock', iconColor: '#0f6cbd' },
  planner: { id: 'scout:planner-sync', name: 'Planner Tasks', type: 'list', icon: 'mdi:clipboard-check-outline', iconColor: '#31752f' },
  'cross-source': { id: 'scout:cross-source', name: 'Cross-Source Items', type: 'folder', icon: 'lucide:workflow', iconColor: '#8b5cf6' },
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sanitizedBody = sanitizeFinanceConnectorWrite(body);
    const { id: requestedId, type, name, enabled, syncMode, pollIntervalMinutes, capabilities, credentials, settings, syncedLists } = sanitizedBody;

    const id = requestedId || crypto.randomUUID();
    const now = new Date().toISOString();
    let connectorSettings = {
      ...(type === 'scout' ? DEFAULT_SCOUT_SETTINGS : {}),
      ...(settings || {}),
      ...(
        (type === 'microsoft-todo' || type === 'github-issues')
        && settings?.syncMicroStatus === undefined
          ? { syncMicroStatus: false }
          : {}
      ),
    };
    if (isFinanceConnectorType(type)) {
      connectorSettings = validateFinanceConnectorSettings(connectorSettings, {
        requireHouseholdCurrency: true,
      });
    }
    let workTodoSettings = null;
    if (type === 'scout') {
      const validation = validateScoutSettings(connectorSettings);
      if (!validation.success) {
        return ApiErrors.badRequest(validation.error);
      }
      connectorSettings = validation.data;
      if (connectorSettings.autoProjectId) {
        const [project] = await db
          .select({ id: hubProjects.id })
          .from(hubProjects)
          .where(eq(hubProjects.id, connectorSettings.autoProjectId));
        if (!project) {
          return ApiErrors.badRequest('autoProjectId must reference an existing project');
        }
      }
    }
    if (type === 'github-issues') {
      try {
        normalizeGitHubOrigin(
          typeof connectorSettings.apiOrigin === 'string'
            ? connectorSettings.apiOrigin
            : undefined,
        );
      } catch (error) {
        return ApiErrors.badRequest(
          error instanceof Error ? error.message : 'Invalid GitHub API origin',
        );
      }
    }
    if (type === 'microsoft-todo-work') {
      const validation = workTodoSettingsSchema.safeParse(settings);
      if (!validation.success) {
        return ApiErrors.badRequest(validation.error.issues[0]?.message ?? 'Invalid Work To Do settings');
      }
      workTodoSettings = validation.data;
      connectorSettings = validation.data;
    }

    runTransaction((tx) => {
      const created = tx.insert(connectorConfigs).values({
        id,
        type,
        name,
        enabled: enabled ?? true,
        syncMode: syncMode || 'poll',
        pollIntervalMinutes: pollIntervalMinutes || 5,
        capabilities: workTodoSettings
          ? capabilitiesForWorkTodo(workTodoSettings)
          : capabilities || { read: true, write: false, delete: false, sync: true, subtasks: false, lists: false },
        credentials: isFinanceConnectorType(type)
          ? protectNewFinanceConnectorCredentials(credentials)
          : credentials || {},
        settings: connectorSettings,
        syncedLists: syncedLists || [],
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning({ id: connectorConfigs.id }).get();
      if (created && type === 'github-issues') {
        createNewGitHubConnectorIdentityState(tx, created.id, now);
      }
    });

    // Auto-create source lists for Scout connector
    if (type === 'scout') {
      for (const [sourceType, listDef] of Object.entries(SCOUT_SOURCE_LISTS)) {
        await db.insert(sourceLists).values({
          id: `sl-scout-${sourceType}`,
          connectorInstanceId: id,
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
    }
    if (workTodoSettings) {
      await db.insert(workTodoBridgeState).values({
        connectorId: id,
        transport: workTodoSettings.transport,
        capabilityProfile: workTodoSettings.capabilityProfile,
        resetRequired: false,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
    }

    await syncScheduler.reconcileScheduleFromDb(id);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof FinanceConnectorConfigurationError) {
      return NextResponse.json(
        { error: error.code, code: error.code },
        { status: 400 },
      );
    }
    if (error instanceof TyrionBridgeUrlValidationError) {
      return ApiErrors.badRequest(error.message);
    }
    return ApiErrors.internal('Failed to create connector', error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;
    let workTodoSettingsUpdate: ReturnType<typeof workTodoSettingsSchema.parse> | null = null;

    if (!id) {
      return ApiErrors.badRequest('Missing connector id');
    }

    const [existing] = await db
      .select({
        type: connectorConfigs.type,
        credentials: connectorConfigs.credentials,
        settings: connectorConfigs.settings,
        updatedAt: connectorConfigs.updatedAt,
      })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id));
    if (updates.type !== undefined && updates.type !== existing?.type) {
      return ApiErrors.badRequest('Connector type cannot be changed');
    }
    if (existing && isFinanceConnectorType(existing.type)) {
      const existingSettings = typeof existing.settings === 'string'
        ? JSON.parse(existing.settings) as Record<string, unknown>
        : (existing.settings as Record<string, unknown> | null) ?? {};
      const requestedSettings = updates.settings === undefined
        ? undefined
        : (updates.settings as Record<string, unknown> | null) ?? {};
      const sanitized = sanitizeFinanceConnectorWrite({
        type: existing.type,
        credentials: updates.credentials,
        settings: requestedSettings === undefined
          ? undefined
          : { ...existingSettings, ...requestedSettings },
      });
      if (updates.credentials !== undefined) {
        if ('serviceToken' in sanitized.credentials) {
          updates.credentials = preserveFinanceConnectorIdentityCredentials(
            sanitized.credentials,
            existing.credentials,
          );
        } else {
          delete updates.credentials;
        }
      }
      if (updates.settings !== undefined) {
        updates.settings = validateFinanceConnectorSettings(sanitized.settings, {
          requireHouseholdCurrency: false,
        });
      }
    }

    if (updates.settings !== undefined) {
      if (existing?.type === 'scout') {
        const validation = validateScoutSettings(updates.settings);
        if (!validation.success) {
          return ApiErrors.badRequest(validation.error);
        }
        if (validation.data.autoProjectId) {
          const [project] = await db
            .select({ id: hubProjects.id })
            .from(hubProjects)
            .where(eq(hubProjects.id, validation.data.autoProjectId));
          if (!project) {
            return ApiErrors.badRequest('autoProjectId must reference an existing project');
          }
        }
        updates.settings = {
          ...(updates.settings as Record<string, unknown>),
          ...validation.data,
        };
      }
      if (existing?.type === 'microsoft-todo-work') {
        const validation = workTodoSettingsSchema.safeParse(updates.settings);
        if (!validation.success) {
          return ApiErrors.badRequest(validation.error.issues[0]?.message ?? 'Invalid Work To Do settings');
        }
        workTodoSettingsUpdate = validation.data;
        updates.settings = validation.data;
        updates.capabilities = capabilitiesForWorkTodo(validation.data);
      }
    }

    const now = new Date().toISOString();
    if (workTodoSettingsUpdate) {
      const settings = workTodoSettingsUpdate;
      const updated = runTransaction((tx) => {
        const bridgeState = tx.select({
          transport: workTodoBridgeState.transport,
          capabilityProfile: workTodoBridgeState.capabilityProfile,
          lastIngestAt: workTodoBridgeState.lastIngestAt,
        }).from(workTodoBridgeState).where(eq(workTodoBridgeState.connectorId, id)).get();
        if (
          bridgeState?.lastIngestAt
          && (
            bridgeState.transport !== settings.transport
            || bridgeState.capabilityProfile !== settings.capabilityProfile
          )
        ) {
          return false;
        }
        tx.update(connectorConfigs)
          .set({ ...updates, updatedAt: now })
          .where(eq(connectorConfigs.id, id))
          .run();
        tx.update(workTodoBridgeState).set({
          transport: settings.transport,
          capabilityProfile: settings.capabilityProfile,
          updatedAt: now,
        }).where(eq(workTodoBridgeState.connectorId, id)).run();
        return true;
      });
      if (!updated) {
        return ApiErrors.conflict('Bridge tier cannot change after the first baseline');
      }
    } else {
      const applyUpdate = async () => {
        const result = await db.update(connectorConfigs)
          .set({ ...updates, updatedAt: now })
          .where(
            existing && isFinanceConnectorType(existing.type)
              ? and(
                  eq(connectorConfigs.id, id),
                  eq(connectorConfigs.updatedAt, existing.updatedAt),
                  eq(connectorConfigs.settings, existing.settings),
                )
              : eq(connectorConfigs.id, id),
          );
        if (
          existing
          && isFinanceConnectorType(existing.type)
          && result.changes !== 1
        ) {
          throw new ConnectorOperationBusyError('Connector configuration changed; retry');
        }
      };
      if (
        existing?.type === 'github-issues'
        && (updates.settings !== undefined || updates.syncedLists !== undefined)
      ) {
        await runWithConnectorOperationLease(id, 'retention', applyUpdate);
      } else {
        await applyUpdate();
      }
    }
    await syncScheduler.reconcileScheduleFromDb(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ConnectorOperationBusyError) {
      return ApiErrors.conflict('Connector has an active operation');
    }
    if (error instanceof TyrionBridgeUrlValidationError) {
      return ApiErrors.badRequest(error.message);
    }
    if (error instanceof FinanceConnectorConfigurationError) {
      return NextResponse.json(
        { error: error.code, code: error.code },
        { status: 400 },
      );
    }
    return ApiErrors.internal('Failed to update connector', error);
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const permanent = searchParams.get('permanent') === 'true';

  if (!id) {
    return ApiErrors.badRequest('Missing connector id');
  }

  try {
    if (permanent) {
      // Hard delete — permanently remove connector and all related data
      try {
        await runWithConnectorOperationLease(id, 'retention', async () => {
          runTransaction((tx) => {
            // Gather task IDs so we can clean up junction/state tables
            const connectorTasks = tx.select({ id: tasks.id })
              .from(tasks)
              .where(eq(tasks.connectorInstanceId, id))
              .all();
            const taskIds = connectorTasks.map(t => t.id);

            if (taskIds.length > 0) {
              tx.delete(taskTags).where(inArray(taskTags.taskId, taskIds)).run();
              tx.delete(projectAutoIncludeExclusions)
                .where(inArray(projectAutoIncludeExclusions.taskId, taskIds))
                .run();
              tx.delete(taskProjects).where(inArray(taskProjects.taskId, taskIds)).run();
              tx.delete(taskSchedules).where(inArray(taskSchedules.taskId, taskIds)).run();
              tx.delete(myDayItems).where(inArray(myDayItems.taskId, taskIds)).run();
              tx.delete(focusItems).where(inArray(focusItems.taskId, taskIds)).run();
              tx.delete(projectPhaseItems).where(inArray(projectPhaseItems.taskId, taskIds)).run();
            }

            tx.delete(syncLog).where(eq(syncLog.connectorId, id)).run();
            tx.delete(workTodoOutboundChanges).where(eq(workTodoOutboundChanges.connectorId, id)).run();
            tx.delete(workTodoListDeltaState).where(eq(workTodoListDeltaState.connectorId, id)).run();
            tx.delete(workTodoBridgeState).where(eq(workTodoBridgeState.connectorId, id)).run();
            tx.delete(sourceLists).where(eq(sourceLists.connectorInstanceId, id)).run();
            tx.delete(notificationPushRules)
              .where(eq(notificationPushRules.connectorInstanceId, id))
              .run();
            tx.delete(financeAttributionAudit).where(eq(financeAttributionAudit.connectorId, id)).run();
            tx.delete(financeAttributionExceptions).where(eq(financeAttributionExceptions.connectorId, id)).run();
            tx.delete(financeAttributionSubjects).where(eq(financeAttributionSubjects.connectorId, id)).run();
            tx.delete(financeMutationAudit).where(eq(financeMutationAudit.connectorId, id)).run();
            tx.delete(financeBudgetSnapshots).where(eq(financeBudgetSnapshots.connectorId, id)).run();
            tx.delete(financeRecurringObligations).where(eq(financeRecurringObligations.connectorId, id)).run();
            tx.delete(financeTags).where(eq(financeTags.connectorId, id)).run();
            tx.delete(financeCategories).where(eq(financeCategories.connectorId, id)).run();
            tx.delete(financeCategoryGroups).where(eq(financeCategoryGroups.connectorId, id)).run();
            tx.delete(financeAccounts).where(eq(financeAccounts.connectorId, id)).run();
            tx.delete(financeDatasetSyncState).where(eq(financeDatasetSyncState.connectorId, id)).run();
            tx.delete(financeInsightOccurrenceCacheState)
              .where(eq(financeInsightOccurrenceCacheState.connectorId, id))
              .run();
            tx.delete(financeInsightOccurrences)
              .where(eq(financeInsightOccurrences.connectorId, id))
              .run();
            tx.delete(financeInsightPublicationFacts)
              .where(inArray(
                financeInsightPublicationFacts.publicationId,
                tx.select({ id: financeInsightPublications.id })
                  .from(financeInsightPublications)
                  .where(eq(financeInsightPublications.connectorId, id)),
              ))
              .run();
            tx.delete(financeInsightPublications)
              .where(eq(financeInsightPublications.connectorId, id))
              .run();
            tx.delete(financeInsightPublicationState)
              .where(eq(financeInsightPublicationState.connectorId, id))
              .run();
            tx.delete(financeInsightTransactionProjectionFacts)
              .where(eq(financeInsightTransactionProjectionFacts.connectorId, id))
              .run();
            tx.delete(financeInsightTransactionProjectionWindows)
              .where(eq(financeInsightTransactionProjectionWindows.connectorId, id))
              .run();
            tx.delete(financeInsightTransactionProjectionState)
              .where(eq(financeInsightTransactionProjectionState.connectorId, id))
              .run();
            tx.delete(financeInsightTransactionWindowProofs)
              .where(eq(financeInsightTransactionWindowProofs.connectorId, id))
              .run();
            tx.delete(financeInsightTransactionBackfillPlans)
              .where(eq(financeInsightTransactionBackfillPlans.connectorId, id))
              .run();
            tx.delete(financeInsightCutovers)
              .where(eq(financeInsightCutovers.connectorId, id))
              .run();
            tx.delete(financeSyncState).where(eq(financeSyncState.connectorId, id)).run();
            tx.delete(financeTransactions)
              .where(eq(financeTransactions.connectorInstanceId, id))
              .run();
            tx.delete(tasks).where(eq(tasks.connectorInstanceId, id)).run();
            tx.delete(connectorConfigs).where(eq(connectorConfigs.id, id)).run();
          });
          await syncScheduler.reconcileScheduleFromDb(id);
        });
      } catch (err) {
        if (err instanceof ConnectorOperationBusyError) {
          return ApiErrors.conflict('Connector has an active operation');
        }
        dbLogger.error({ err, connectorId: id, op: 'hardDeleteConnector' },
          'Transaction rolled back: connector hard-delete failed mid-cascade');
        throw err;
      }
      return NextResponse.json({ success: true, mode: 'permanent' });
    }

    // Soft delete — mark as deleted, disable sync
    const now = new Date().toISOString();
    await db.update(connectorConfigs)
      .set({ deletedAt: now, enabled: false, updatedAt: now })
      .where(eq(connectorConfigs.id, id));
    await syncScheduler.reconcileScheduleFromDb(id);

    // Count affected data for the response
    const [taskCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(eq(tasks.connectorInstanceId, id));
    const [listCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sourceLists)
      .where(eq(sourceLists.connectorInstanceId, id));

    return NextResponse.json({
      success: true,
      mode: 'soft',
      deletedAt: now,
      affectedTasks: taskCount?.count || 0,
      affectedLists: listCount?.count || 0,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to delete connector', error);
  }
}
