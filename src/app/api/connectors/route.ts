import { NextResponse } from 'next/server';
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
import type { ManagedConnectorUpdate } from '@/db/persistence/connector-management';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const includeDeleted = searchParams.get('includeDeleted') === 'true';

  try {
    const persistence = await getConnectorManagementPersistence();
    let overview = await persistence.getOverview(includeDeleted);
    let { connectors: configs, sourceLists: lists } = overview;

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
        await persistence.ensureSourceLists(missingLists.map(([sourceType, listDef]) => ({
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
        })));
        overview = await persistence.getOverview(includeDeleted);
        configs = overview.connectors;
        lists = overview.sourceLists;
      }
    }

    const countMap = new Map(
      overview.openTaskCounts.map(tc => [
        `${tc.connectorInstanceId}:${tc.sourceListId}`,
        tc.count,
      ]),
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

    const lastSyncMap = new Map(
      overview.syncOutcomes.map((row) => [row.connectorId, row.lastSyncedAt]),
    );

    // Get the outcome of the most recent sync attempt (success or failure) per
    // connector, regardless of overall status, so the settings UI can surface an
    // ongoing failure (e.g. an expired OAuth token) instead of only showing
    // "credentials stored" as if the connection were healthy.
    const lastSyncStatusMap = new Map<string, { success: boolean; error: string | null }>();
    for (const row of overview.syncOutcomes) {
      lastSyncStatusMap.set(row.connectorId, {
        success: row.success === true,
        error: row.error,
      });
    }

    // Merge lastSyncedAt and capability defaults into connector configs
    const connectors = configs.map(c => {
      const defaults = CAPABILITY_DEFAULTS[c.type] ?? {};
      const storedCaps = c.capabilities ?? {};
      const lastOutcome = lastSyncStatusMap.get(c.id);
      return serializeConnectorForBrowser({
        ...c,
        capabilities: { ...defaults, ...storedCaps },
        lastSyncedAt: lastSyncMap.get(c.id) || null,
        lastSyncStatus: lastOutcome ? (lastOutcome.success ? 'success' : 'failed') : null,
        lastSyncError: lastOutcome?.error ?? null,
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
    const persistence = await getConnectorManagementPersistence();
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
        if (!(await persistence.projectExists(connectorSettings.autoProjectId))) {
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

    await persistence.createConnector({
      id,
      type,
      name,
      enabled: enabled ?? true,
      syncMode: syncMode || 'poll',
      pollIntervalMinutes: pollIntervalMinutes || 5,
      capabilities: workTodoSettings
        ? capabilitiesForWorkTodo(workTodoSettings)
        : capabilities || {
            read: true,
            write: false,
            delete: false,
            sync: true,
            subtasks: false,
            lists: false,
            tags: false,
            tagWriteBack: false,
          },
      credentials: isFinanceConnectorType(type)
        ? protectNewFinanceConnectorCredentials(credentials)
        : credentials || {},
      settings: connectorSettings,
      syncedLists: syncedLists || [],
      now,
    });

    // Auto-create source lists for Scout connector
    if (type === 'scout') {
      await persistence.ensureSourceLists(
        Object.entries(SCOUT_SOURCE_LISTS).map(([sourceType, listDef]) => ({
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
        })),
      );
    }
    if (workTodoSettings) {
      await persistence.ensureWorkTodoBridge({
        connectorId: id,
        transport: workTodoSettings.transport,
        capabilityProfile: workTodoSettings.capabilityProfile,
        now,
      });
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
    const persistence = await getConnectorManagementPersistence();
    const body = await request.json();
    const { id, ...updates } = body;
    let workTodoSettingsUpdate: ReturnType<typeof workTodoSettingsSchema.parse> | null = null;

    if (!id) {
      return ApiErrors.badRequest('Missing connector id');
    }

    const existing = await persistence.getConnector(id);
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
          if (!(await persistence.projectExists(validation.data.autoProjectId))) {
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
    const connectorUpdates: ManagedConnectorUpdate = {};
    if (updates.name !== undefined) connectorUpdates.name = updates.name;
    if (updates.enabled !== undefined) connectorUpdates.enabled = updates.enabled;
    if (updates.syncMode !== undefined) connectorUpdates.syncMode = updates.syncMode;
    if (updates.pollIntervalMinutes !== undefined) {
      connectorUpdates.pollIntervalMinutes = updates.pollIntervalMinutes;
    }
    if (updates.capabilities !== undefined) connectorUpdates.capabilities = updates.capabilities;
    if (updates.credentials !== undefined) connectorUpdates.credentials = updates.credentials;
    if (updates.settings !== undefined) connectorUpdates.settings = updates.settings;
    if (updates.syncedLists !== undefined) connectorUpdates.syncedLists = updates.syncedLists;

    if (workTodoSettingsUpdate) {
      const settings = workTodoSettingsUpdate;
      const result = await persistence.updateWorkTodoConnector({
        connectorId: id,
        updates: connectorUpdates,
        transport: settings.transport,
        capabilityProfile: settings.capabilityProfile,
        now,
      });
      if (result === 'tier-conflict') {
        return ApiErrors.conflict('Bridge tier cannot change after the first baseline');
      }
    } else {
      const applyUpdate = async () => {
        const updated = await persistence.updateConnector({
          connectorId: id,
          updates: connectorUpdates,
          now,
          expected: existing && isFinanceConnectorType(existing.type)
            ? { updatedAt: existing.updatedAt, settings: existing.settings }
            : undefined,
        });
        if (
          existing
          && isFinanceConnectorType(existing.type)
          && !updated
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
    const persistence = await getConnectorManagementPersistence();
    if (permanent) {
      // Hard delete — permanently remove connector and all related data
      try {
        await runWithConnectorOperationLease(id, 'retention', async () => {
          await persistence.hardDeleteConnector(id);
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
    const affected = await persistence.softDeleteConnector(id, now);
    await syncScheduler.reconcileScheduleFromDb(id);

    return NextResponse.json({
      success: true,
      mode: 'soft',
      deletedAt: now,
      affectedTasks: affected.affectedTasks,
      affectedLists: affected.affectedLists,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to delete connector', error);
  }
}
