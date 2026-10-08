import type { ConnectorFactory, IConnector } from '../index';
import type { NotificationWritebackAction } from '../notification-writeback-contract';
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

import { companionActionV2Digest } from './action-contract-v2';
import {
  CompanionActionHttpError,
  createCompanionActionClient,
  type CompanionActionClient,
} from './companion-action-client';
import {
  COMPANION_ACTION_MAX_SYNC_PAGES,
  normalizeTrustedOrigin,
  normalizeTrustedOrigins,
} from './action-contract-v2';
import { stableCompanionOperationId } from './operation-id';
import { projectCompanionActionV2PageToNotifications } from './notification-projection';
import {
  applyManagedRyMessageCommands,
  attachImportedRyMessageManagers,
  observeManagedRyMessageTasks,
} from './task-promotion';
import { flushRyMessageV2MutationOutbox } from './durable-v2-mutations';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  RyMessageActionPersistenceError,
  type RyMessageActionV2Projection,
} from '@/db/persistence/rymessage-actions';

/**
 * RyMessage Action Center Connector
 *
 * Reads AI-extracted actions from RyMessage's Action Center.
 */

interface RyMessageConfig {
  mode: 'companion';
  companionBaseUrl?: string;
  trustedMissionControlOrigin?: string;
  trustedTaskOrigins?: string[];
  credentialEnv?: string;
}

function summarizeV2Changes(
  before: readonly RyMessageActionV2Projection[],
  after: readonly RyMessageActionV2Projection[],
): Pick<DomainSyncResult, 'itemsAdded' | 'itemsUpdated' | 'itemsRemoved'> {
  const previous = new Map(before.map(projection => [projection.actionId, projection]));
  let itemsAdded = 0;
  let itemsUpdated = 0;
  let itemsRemoved = 0;
  for (const projection of after) {
    const prior = previous.get(projection.actionId);
    if (!projection.item) {
      if (!prior || prior.item) itemsRemoved++;
      continue;
    }
    if (!prior || !prior.item) {
      itemsAdded++;
      continue;
    }
    if (
      projection.revision !== prior.revision
      || companionActionV2Digest(projection.item) !== companionActionV2Digest(prior.item)
    ) {
      itemsUpdated++;
    }
  }
  return { itemsAdded, itemsUpdated, itemsRemoved };
}

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
  private settings: RyMessageConfig = { mode: 'companion' };
  private companionClient: CompanionActionClient | null = null;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
    this.settings = {
      mode: 'companion',
      ...(config.settings as unknown as Partial<RyMessageConfig>),
    };
    if (this.settings.mode !== 'companion') {
      throw new Error('RyMessage only supports Companion ActionV2 mode');
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
    if (!trustedMissionControlOrigin) {
      throw new Error('Companion ActionV2 requires an exact trusted Mission Control origin');
    }
    const trustedTaskOrigins = normalizeTrustedOrigins(this.settings.trustedTaskOrigins);
    if (!trustedTaskOrigins) {
      throw new Error('Companion trusted task origins must be exact HTTP(S) origins');
    }
    this.settings.trustedTaskOrigins = trustedTaskOrigins;
    this.companionClient = createCompanionActionClient({
      baseUrl,
      credential,
      trustedMissionControlOrigin,
      trustedTaskOrigins,
    });
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.companionClient!.fetchPageV2(null);
      return { success: true, message: 'Connected to Companion ActionV2 feed' };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err}` };
    }
  }

  async dispose(): Promise<void> {
    this.config = null;
    this.companionClient = null;
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
    void since;
    return [];
  }

  async getLastSyncToken(): Promise<string | null> {
    const persistence = (await getWorkerPersistenceRepositories())
      .connectorState.rymessageActions;
    return (await persistence.readV2FeedState(this.id)).cursor;
  }

  async syncDomainData(context: DomainSyncContext): Promise<DomainSyncResult> {
    const throwIfAborted = () => {
      if (!context.signal?.aborted) return;
      throw context.signal.reason ?? new DOMException('RyMessage sync aborted', 'AbortError');
    };
    throwIfAborted();
    const persistence = (await getWorkerPersistenceRepositories())
      .connectorState.rymessageActions;
    const initialProjections = await persistence.listV2Projections(this.id);
    throwIfAborted();
    await flushRyMessageV2MutationOutbox(this.id, this.companionClient!, context.signal);
    let v2Cursor = (await persistence.readV2FeedState(this.id)).cursor;
    let recoveryAttempted = false;
    for (let pageIndex = 0; pageIndex < COMPANION_ACTION_MAX_SYNC_PAGES; pageIndex++) {
      throwIfAborted();
      let page;
      try {
        page = await this.companionClient!.fetchPageV2(v2Cursor, context.signal);
        await persistence.applyV2FeedPage({
          connectorId: this.id,
          page,
          requestedCursor: v2Cursor,
          receivedAt: new Date().toISOString(),
        });
        throwIfAborted();
      } catch (error) {
        const recoverable = (
          error instanceof CompanionActionHttpError
          && error.status === 410
          && ['cursor_invalid', 'cursor_expired'].includes(error.code)
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
    throwIfAborted();
    const v2State = await persistence.readV2FeedState(this.id);
    const finalProjections = await persistence.listV2Projections(this.id);
    throwIfAborted();
    const persistedItems = finalProjections.map(projection => (
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
    await projectCompanionActionV2PageToNotifications(this.id, persistedPage, context.signal);
    await attachImportedRyMessageManagers(
      persistedPage,
      this.companionClient!,
      this.id,
      this.settings.trustedMissionControlOrigin!,
      context.signal,
    );
    await applyManagedRyMessageCommands(
      persistedPage,
      this.companionClient!,
      this.id,
      context.signal,
    );
    await observeManagedRyMessageTasks(
      persistedPage,
      this.companionClient!,
      this.id,
      context.signal,
    );
    const changes = summarizeV2Changes(initialProjections, finalProjections);
    return {
      ...changes,
      status: 'fresh',
    };
  }

  async writeNotificationAction(
    sourceId: string,
    action: NotificationWritebackAction,
  ): Promise<void> {
    if (action !== 'mark_done') {
      throw new Error(`RyMessage does not support notification action ${action}`);
    }
    const match = /^companion:[^:]+:([0-9a-f-]+)$/i.exec(sourceId);
    const actionId = match?.[1];
    if (!actionId) throw new Error('RyMessage notification source identity is invalid');
    const repository = (await getWorkerPersistenceRepositories())
      .connectorState.rymessageActions;
    const projection = await repository.getV2Projection(this.id, actionId);
    const v2Action = projection?.item?.kind === 'upsert'
      ? projection.item.projection.action
      : null;
    const canonical = v2Action;
    if (!canonical) throw new Error('RyMessage action is no longer available');
    await repository.enqueueV2Mutation({
      connectorId: this.id,
      now: new Date().toISOString(),
      request: {
        contractVersion: '2.0',
        actionId,
      operationId: stableCompanionOperationId(
        `rymessage:dismiss:${this.id}:${actionId}:${canonical.revision}`,
      ),
      baseRevision: canonical.revision,
      mutation: { kind: 'action.lifecycle', state: 'dismissed' },
      },
    });
  }

  /**
   * "Clear and refresh": re-fetch actions and filter by active lifecycle states.
   * Actions that have transitioned to handled/dismissed/completed won't appear,
   * so their notifications get auto-resolved.
   */
  async getActiveAlertSourceIds(since?: Date): Promise<string[] | null> {
    void since;
    return null;
  }
}

export const rymessageFactory: ConnectorFactory = {
  create: () => new RyMessageConnector(),
};

export const ryMessageFactory = rymessageFactory;