import type { ConnectorFactory, IConnector } from '../index';
import type {
  TaskItem,
  InboundNotification,
  ConnectorConfig,
  ConnectorCapabilities,
  SourceList,
  DomainSyncContext,
  DomainSyncResult,
} from '@/types';
import { randomUUID } from 'crypto';

import { createRyMessageClient } from './rymessage-client';
import type { RyMessageClient } from './rymessage-client';
import { normalizeActionRecord, shouldImportAction, mapActionToAlert } from './message-transformer';
import type { RyMessageAction } from './message-transformer';
import {
  CompanionActionHttpError,
  createCompanionActionClient,
  type CompanionActionClient,
} from './companion-action-client';
import { CompanionActionReconciliationService } from './companion-action-service';
import type {
  CompanionActionMutation,
} from './action-contract';
import { COMPANION_ACTION_MAX_SYNC_PAGES } from './action-contract';
import { normalizeTrustedOrigin } from './action-contract-v2';
import { projectCompanionActionV2PageToNotifications } from './notification-projection';
import {
  applyManagedRyMessageCommands,
  attachImportedRyMessageManagers,
  observeManagedRyMessageTasks,
} from './task-promotion';
import { flushRyMessageV2MutationOutbox } from './durable-v2-mutations';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { RyMessageActionPersistenceError } from '@/db/persistence/rymessage-actions';

export type { RyMessageAction } from './message-transformer';

/**
 * RyMessage Action Center Connector
 *
 * Reads AI-extracted actions from RyMessage's Action Center.
 *
 * Integration modes:
 * - **webhook** (preferred): RyMessage pushes events to POST /api/integrations/rymessage.
 * - **rest** (dev/fallback): MC polls RyMessage's local REST API.
 * - **sqlite** (dev/fallback): MC reads RyMessage's SQLite database directly.
 */

interface RyMessageConfig {
  mode: 'companion' | 'webhook' | 'sqlite' | 'rest';
  sqlitePath?: string;
  restUrl?: string;
  apiKey?: string;
  companionBaseUrl?: string;
  trustedMissionControlOrigin?: string;
  credentialEnv?: string;
  minConfidence: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.7;

export class RyMessageConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'rymessage';
  readonly displayName = 'RyMessage Action Center';
  readonly icon = '\uD83D\uDCAC';
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: false,
    delete: false,
    sync: true,
    subtasks: false,
    lists: false,
    tags: false,
    tagWriteBack: false,
    listSelectionMode: 'not-applicable',
    notificationOnly: true,
  };

  private config: ConnectorConfig | null = null;
  private settings: RyMessageConfig = { mode: 'rest', minConfidence: DEFAULT_MIN_CONFIDENCE };
  private client: RyMessageClient | null = null;
  private companionClient: CompanionActionClient | null = null;
  private companionService: CompanionActionReconciliationService | null = null;
  private companionV2Enabled = false;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
    this.settings = {
      mode: 'webhook',
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      ...(config.settings as unknown as Partial<RyMessageConfig>),
    };
    if (this.settings.mode === 'companion') {
      if (this.settings.apiKey) {
        throw new Error(
          'Companion credentials must be supplied through an environment variable, not connector settings',
        );
      }
      const credentialEnv = this.settings.credentialEnv
        ?? 'RYMESSAGE_COMPANION_ACTION_FEED_TOKEN';
      if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(credentialEnv)) {
        throw new Error('Invalid Companion credential environment variable name');
      }
      const credential = process.env[credentialEnv];
      if (!credential) {
        throw new Error(`Companion credential environment variable ${credentialEnv} is not set`);
      }
      const baseUrl = this.settings.companionBaseUrl?.trim();
      if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
        throw new Error('Companion action feed URL must be an absolute HTTP(S) URL');
      }
      const trustedMissionControlOrigin = normalizeTrustedOrigin(
        this.settings.trustedMissionControlOrigin,
      );
      this.companionV2Enabled = Boolean(trustedMissionControlOrigin);
      this.companionClient = createCompanionActionClient({
        baseUrl,
        credential,
        ...(trustedMissionControlOrigin
          ? { trustedMissionControlOrigin }
          : {}),
      });
      this.companionService = new CompanionActionReconciliationService(
        config.id,
        this.companionClient,
      );
      this.client = null;
      return;
    }
    this.client = createRyMessageClient({
      mode: this.settings.mode,
      restUrl: this.settings.restUrl,
      sqlitePath: this.settings.sqlitePath,
      apiKey: this.settings.apiKey,
    });
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.settings.mode === 'companion') {
        await this.companionClient!.fetchPage(null);
        if (this.companionV2Enabled) {
          await this.companionClient!.fetchPageV2(null);
          return { success: true, message: 'Connected to Companion ActionV1 and ActionV2 feeds' };
        }
        return {
          success: true,
          message: 'Connected to Companion ActionV1 feed; configure a trusted Mission Control origin to enable ActionV2',
        };
      }
      if (this.settings.mode === 'webhook') {
        return { success: true, message: 'Webhook mode: awaiting pushes from RyMessage' };
      }

      if (this.settings.mode === 'rest') {
        const result = await this.client!.testRest();
        if (result.ok) {
          return { success: true, message: 'Connected to RyMessage REST API' };
        }
        return { success: false, message: `HTTP ${result.status}` };
      }

      const result = await this.client!.testSqlite();
      if (result.exists) {
        return { success: true, message: `Database found at ${result.path}` };
      }
      return { success: false, message: 'Database file not found' };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err}` };
    }
  }

  async dispose(): Promise<void> {
    this.config = null;
    this.client = null;
    this.companionClient = null;
    this.companionService = null;
    this.companionV2Enabled = false;
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    return [{
      id: `${this.id}:actions`,
      connectorInstanceId: this.id,
      sourceId: 'action-center',
      name: 'Action Center',
      type: 'folder' as const,
      taskCount: 0,
      lastSyncedAt: new Date().toISOString(),
    }];
  }

  async *fetchTasks(since?: Date): AsyncGenerator<TaskItem[], void, unknown> {
    void since;
    yield [];
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    if (this.settings.mode === 'webhook' || this.settings.mode === 'companion') return [];

    const rawActions = await this.client!.fetchActions(since);
    const actions = rawActions
      .map((record) => normalizeActionRecord(record))
      .filter((action): action is RyMessageAction => action !== null);

    const filtered = since
      ? actions.filter((action) => {
          const actionTime = Date.parse(action.updatedAt ?? action.createdAt);
          return Number.isFinite(actionTime) ? actionTime > since.getTime() : true;
        })
      : actions;

    return filtered
      .filter((action) => shouldImportAction(action, this.settings.minConfidence))
      .map((action) => mapActionToAlert(action, this.type, this.id, randomUUID()));
  }

  async getLastSyncToken(): Promise<string | null> {
    if (this.settings.mode === 'companion') {
      const persistence = (await getWorkerPersistenceRepositories())
        .connectorState.rymessageActions;
      return (await persistence.readFeedState(this.id)).cursor;
    }
    return null;
  }

  async syncDomainData(context: DomainSyncContext): Promise<DomainSyncResult> {
    if (this.settings.mode !== 'companion') {
      return { itemsAdded: 0, itemsUpdated: 0, itemsRemoved: 0, status: 'fresh' };
    }
    const result = await this.companionService!.sync(context.signal);
    if (!this.companionV2Enabled) {
      return {
        itemsAdded: result.itemsAdded,
        itemsUpdated: result.itemsUpdated,
        itemsRemoved: result.itemsRemoved,
        status: result.status,
      };
    }
    const persistence = (await getWorkerPersistenceRepositories())
      .connectorState.rymessageActions;
    await flushRyMessageV2MutationOutbox(this.id, this.companionClient!, context.signal);
    let v2Cursor = (await persistence.readV2FeedState(this.id)).cursor;
    let recoveryAttempted = false;
    for (let pageIndex = 0; pageIndex < COMPANION_ACTION_MAX_SYNC_PAGES; pageIndex++) {
      let page;
      try {
        page = await this.companionClient!.fetchPageV2(v2Cursor, context.signal);
        await persistence.applyV2FeedPage({
          connectorId: this.id,
          page,
          requestedCursor: v2Cursor,
          receivedAt: new Date().toISOString(),
        });
      } catch (error) {
        const recoverable = (
          error instanceof CompanionActionHttpError && error.status === 410
        ) || (
          error instanceof RyMessageActionPersistenceError
          && ['FEED_IDENTITY_CHANGED', 'REVISION_CONFLICT'].includes(error.code)
        );
        if (!recoverable || recoveryAttempted) throw error;
        await persistence.invalidateV2Recovery({
          connectorId: this.id,
          reason: error instanceof Error ? error.message : 'ActionV2 recovery required',
          now: new Date().toISOString(),
        });
        recoveryAttempted = true;
        v2Cursor = null;
        pageIndex = -1;
        continue;
      }
      if (page.complete) break;
      if (!page.nextCursor || page.nextCursor === v2Cursor) {
        throw new Error('Companion ActionV2 feed did not advance its cursor');
      }
      v2Cursor = page.nextCursor;
      if (pageIndex === COMPANION_ACTION_MAX_SYNC_PAGES - 1) {
        throw new Error('Companion ActionV2 feed exceeded the bounded page limit');
      }
    }
    const v2State = await persistence.readV2FeedState(this.id);
    const persistedItems = (await persistence.listV2Projections(this.id)).map(projection => (
      projection.item ?? {
        eventId: randomUUID(),
        operationId: randomUUID(),
        aggregateId: projection.actionId,
        aggregateVersion: projection.revision,
        sourceId: projection.sourceId,
        occurredAt: projection.tombstonedAt ?? new Date().toISOString(),
        kind: 'tombstone' as const,
      }
    ));
    const persistedPage = {
      schemaVersion: '2.0' as const,
      feedId: v2State.feedId ?? randomUUID(),
      mode: 'incremental' as const,
      producedAt: new Date().toISOString(),
      nextCursor: v2State.cursor ?? 'recovery',
      complete: true,
      items: persistedItems,
    };
    await projectCompanionActionV2PageToNotifications(this.id, persistedPage);
    await attachImportedRyMessageManagers(
      persistedPage,
      this.companionClient!,
      this.id,
      this.settings.trustedMissionControlOrigin!,
    );
    await applyManagedRyMessageCommands(
      persistedPage,
      this.companionClient!,
      this.id,
    );
    await observeManagedRyMessageTasks(
      persistedPage,
      this.companionClient!,
      this.id,
    );
    return {
      itemsAdded: result.itemsAdded,
      itemsUpdated: result.itemsUpdated,
      itemsRemoved: result.itemsRemoved,
      status: result.status,
    };
  }

  async queueActionMutation(input: {
    actionId: string;
    operationId: string;
    baseRevision: number;
    expectedFieldRevisions: Readonly<Record<string, number>>;
    mutation: Exclude<CompanionActionMutation, { kind: 'materialization.observe' }>;
  }): Promise<{ operationId: string; queued: boolean }> {
    if (this.settings.mode !== 'companion' || !this.companionService) {
      throw new Error('Companion action reconciliation is not enabled');
    }
    return this.companionService.queueMutation(input);
  }

  /**
   * "Clear and refresh": re-fetch actions and filter by active lifecycle states.
   * Actions that have transitioned to handled/dismissed/completed won't appear,
   * so their notifications get auto-resolved.
   */
  async getActiveAlertSourceIds(since?: Date): Promise<string[] | null> {
    if (this.settings.mode === 'webhook' || this.settings.mode === 'companion') return null;

    try {
      const notifications = await this.fetchNotifications(since);
      // fetchNotifications returns notifications with sourceId like "rymessage:{id}"
      return notifications.map((notification) => notification.id);
    } catch {
      return null; // Fail-open
    }
  }
}

export const rymessageFactory: ConnectorFactory = {
  create: () => new RyMessageConnector(),
};

export const ryMessageFactory = rymessageFactory;