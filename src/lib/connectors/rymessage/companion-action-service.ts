import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { RyMessageActionPersistence } from '@/db/persistence/rymessage-actions';
import {
  COMPANION_ACTION_MAX_SYNC_PAGES,
  isCompanionActionMutation,
  type CompanionActionQueueRequest,
  type CompanionActionMutation,
} from './action-contract';
import {
  CompanionActionHttpError,
  type CompanionActionClient,
} from './companion-action-client';

export interface CompanionActionSyncResult {
  itemsAdded: number;
  itemsUpdated: number;
  itemsRemoved: number;
  status: 'fresh' | 'partial' | 'unavailable';
  relations: {
    linked: number;
    pendingImport: number;
    conflicts: number;
    broken: number;
  };
  mutations: {
    succeeded: number;
    conflicts: number;
    deferred: number;
  };
}

async function defaultPersistence(): Promise<RyMessageActionPersistence> {
  return (await getWorkerPersistenceRepositories()).connectorState.rymessageActions;
}

export async function queueCompanionActionMutation(
  connectorId: string,
  input: CompanionActionQueueRequest,
  persistence: () => Promise<RyMessageActionPersistence> = defaultPersistence,
): Promise<{ operationId: string; queued: boolean }> {
  if (!isCompanionActionMutation(input.mutation)) {
    throw new Error('Companion action mutation is outside the allowed integration authority');
  }
  const repository = await persistence();
  const outcome = await repository.enqueueMutation({
    connectorId,
    actionId: input.actionId,
    operationId: input.operationId,
    baseRevision: input.baseRevision,
    expectedFieldRevisions: input.expectedFieldRevisions,
    mutation: input.mutation,
    now: new Date().toISOString(),
  });
  return { operationId: input.operationId, queued: outcome === 'queued' };
}

export class CompanionActionReconciliationService {
  constructor(
    private readonly connectorId: string,
    private readonly client: CompanionActionClient,
    private readonly persistence: () => Promise<RyMessageActionPersistence> = defaultPersistence,
  ) {}

  async sync(signal?: AbortSignal): Promise<CompanionActionSyncResult> {
    const repository = await this.persistence();
    let state = await repository.readFeedState(this.connectorId);
    let cursor = state.cursor;
    let recoveryRetried = false;
    let pageCount = 0;
    let caughtUp = false;
    let itemsAdded = 0;
    let itemsUpdated = 0;
    let itemsRemoved = 0;

    if (
      state.recoveryRequired
      && state.cursor !== null
      && state.lastError?.startsWith('REVISION_CONFLICT:')
    ) {
      return {
        itemsAdded,
        itemsUpdated,
        itemsRemoved,
        status: 'unavailable',
        relations: { linked: 0, pendingImport: 0, conflicts: 1, broken: 0 },
        mutations: { succeeded: 0, conflicts: 0, deferred: 0 },
      };
    }

    while (pageCount < COMPANION_ACTION_MAX_SYNC_PAGES) {
      if (signal?.aborted) throw signal.reason ?? new Error('RyMessage action sync aborted');
      let page;
      try {
        page = await this.client.fetchPage(cursor, signal);
      } catch (error) {
        if (
          error instanceof CompanionActionHttpError
          && error.status === 410
          && !recoveryRetried
        ) {
          await repository.invalidateRecovery({
            connectorId: this.connectorId,
            reason: error.code,
            now: new Date().toISOString(),
          });
          state = await repository.readFeedState(this.connectorId);
          cursor = state.cursor;
          recoveryRetried = true;
          continue;
        }
        throw error;
      }

      try {
        const result = await repository.applyFeedPage({
          connectorId: this.connectorId,
          page,
          requestedCursor: cursor,
          receivedAt: new Date().toISOString(),
        });
        itemsAdded += result.added;
        itemsUpdated += result.updated;
        itemsRemoved += result.tombstoned;
        if (result.recoveryRequired) {
          if (result.conflicts > 0) {
            return {
              itemsAdded,
              itemsUpdated,
              itemsRemoved,
              status: 'unavailable',
              relations: {
                linked: 0,
                pendingImport: 0,
                conflicts: result.conflicts,
                broken: 0,
              },
              mutations: { succeeded: 0, conflicts: 0, deferred: 0 },
            };
          }
          if (recoveryRetried) {
            throw new Error('Companion action feed recovery restarted more than once');
          }
          cursor = null;
          recoveryRetried = true;
          continue;
        }
      } catch (error) {
        if (
          error instanceof Error
          && 'code' in error
          && error.code === 'FEED_IDENTITY_CHANGED'
          && !recoveryRetried
        ) {
          await repository.invalidateRecovery({
            connectorId: this.connectorId,
            reason: 'feed-identity-changed',
            now: new Date().toISOString(),
          });
          cursor = null;
          recoveryRetried = true;
          continue;
        }
        throw error;
      }
      cursor = page.nextCursor;
      pageCount++;
      if (page.complete) {
        caughtUp = true;
        break;
      }
    }
    if (!caughtUp) {
      throw new Error('Companion action feed exceeded the bounded page limit');
    }

    const relations = await repository.reconcileMaterializations({
      connectorId: this.connectorId,
      now: new Date().toISOString(),
    });
    const mutations = await this.flushMutations(repository, signal);
    return {
      itemsAdded,
      itemsUpdated,
      itemsRemoved,
      status: relations.conflicts > 0 || relations.broken > 0 ? 'partial' : 'fresh',
      relations: {
        linked: relations.linked,
        pendingImport: relations.pendingImport,
        conflicts: relations.conflicts,
        broken: relations.broken,
      },
      mutations,
    };
  }

  async queueMutation(input: {
    actionId: string;
    operationId: string;
    baseRevision: number;
    expectedFieldRevisions: Readonly<Record<string, number>>;
    mutation: Exclude<CompanionActionMutation, { kind: 'materialization.observe' }>;
  }): Promise<{ operationId: string; queued: boolean }> {
    return queueCompanionActionMutation(this.connectorId, input, this.persistence);
  }

  private async flushMutations(
    repository: RyMessageActionPersistence,
    signal?: AbortSignal,
  ): Promise<{ succeeded: number; conflicts: number; deferred: number }> {
    const lease = await repository.leaseMutations({
      connectorId: this.connectorId,
      now: new Date().toISOString(),
    });
    let succeeded = 0;
    let conflicts = 0;
    let deferred = 0;
    for (const item of lease.items) {
      if (signal?.aborted) {
        deferred += 1;
        continue;
      }
      try {
        const receipt = await this.client.submitMutation({
          contractVersion: '1.0',
          operationId: item.operationId,
          actionId: item.actionId,
          baseRevision: item.baseRevision,
          mutation: item.mutation,
        }, signal);
        await repository.completeMutation({
          connectorId: this.connectorId,
          operationId: item.operationId,
          leaseId: lease.leaseId,
          receipt,
          retryable: false,
          now: new Date().toISOString(),
        });
        if (receipt.outcome === 'conflict') conflicts++;
        else succeeded++;
      } catch (error) {
        const httpError = error instanceof CompanionActionHttpError ? error : null;
        await repository.completeMutation({
          connectorId: this.connectorId,
          operationId: item.operationId,
          leaseId: lease.leaseId,
          errorCode: httpError?.code ?? 'transport_error',
          errorMessage: httpError?.message ?? (
            error instanceof Error ? error.message : 'Companion mutation failed'
          ),
          retryable: httpError?.retryable ?? true,
          now: new Date().toISOString(),
        });
        deferred++;
      }
    }
    return { succeeded, conflicts, deferred };
  }
}
