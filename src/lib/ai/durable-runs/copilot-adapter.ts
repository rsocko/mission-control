import 'server-only';

import {
  COPILOT_EXECUTION_ROUTE,
  COPILOT_PROVIDER,
  type HoustonRunEvent,
  type HoustonRunEventCursor,
  type HoustonRunEventSink,
} from '../copilot-run-events';
import type {
  CopilotRunRecord,
  CopilotRunState,
  CopilotRunStore,
  CopilotTerminalState,
  CreateCopilotRunInput,
} from '../copilot-session-lifecycle';
import type { DurableAiRunRepository } from './repository';
import { getDurableAiRunRepository } from './runtime';
import type {
  ClaimedDurableAiRun,
  DurableAiRunEvent,
  DurableAiRunStatus,
} from './types';

const COPILOT_RUN_STATES = new Set<CopilotRunState>([
  'creating',
  'active',
  'idle',
  'resuming',
  'cancelling',
  'completed',
  'failed',
  'timed_out',
  'cleaned_up',
]);
const COPILOT_TERMINAL_STATES = new Set<CopilotTerminalState>([
  'completed',
  'cancelled',
  'failed',
  'timed_out',
]);

function durableStatus(
  state: CopilotRunState,
  terminalState?: CopilotTerminalState,
): DurableAiRunStatus {
  if (state === 'cancelling') return 'cancelling';
  if (state === 'timed_out' || terminalState === 'timed_out') return 'timed_out';
  if (terminalState === 'cancelled') return 'cancelled';
  if (state === 'failed' || terminalState === 'failed') return 'failed';
  if (
    state === 'completed'
    || state === 'cleaned_up'
    || terminalState === 'completed'
  ) {
    return 'succeeded';
  }
  return 'running';
}

function transitionGuard(status: DurableAiRunStatus): {
  allowedCurrentStatuses: readonly DurableAiRunStatus[];
  cancellation?: 'absent';
} {
  switch (status) {
    case 'running':
      return { allowedCurrentStatuses: ['running'], cancellation: 'absent' };
    case 'cancelling':
      return { allowedCurrentStatuses: ['running', 'cancelling'] };
    case 'succeeded':
      return {
        allowedCurrentStatuses: ['running', 'succeeded'],
        cancellation: 'absent',
      };
    case 'failed':
      return {
        allowedCurrentStatuses: ['running', 'failed'],
        cancellation: 'absent',
      };
    case 'timed_out':
      return {
        allowedCurrentStatuses: ['running', 'timed_out'],
        cancellation: 'absent',
      };
    case 'cancelled':
      return {
        allowedCurrentStatuses: ['running', 'cancelling', 'cancelled'],
      };
    case 'queued':
      return { allowedCurrentStatuses: ['queued'] };
  }
}

function recordState(record: CopilotRunRecord): Record<string, unknown> {
  const state: Partial<CopilotRunRecord> = { ...record };
  delete state.providerSessionId;
  return state;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCopilotRunState(value: unknown): value is CopilotRunState {
  return isString(value) && COPILOT_RUN_STATES.has(value as CopilotRunState);
}

function isCopilotTerminalState(value: unknown): value is CopilotTerminalState {
  return isString(value)
    && COPILOT_TERMINAL_STATES.has(value as CopilotTerminalState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(
  state: Record<string, unknown> | null,
  providerSessionId?: string,
): CopilotRunRecord | undefined {
  if (
    !state
    || !isString(state.runId)
    || !isString(state.featureId)
    || state.sensitivity !== 'standard'
    || !isString(state.correlationId)
    || !isString(state.model)
    || !isCopilotRunState(state.state)
    || (state.connection !== 'attached' && state.connection !== 'detached')
    || !isString(state.ownerId)
    || typeof state.leaseExpiresAt !== 'number'
    || typeof state.revision !== 'number'
    || typeof state.createdAt !== 'number'
    || typeof state.updatedAt !== 'number'
    || !isRecord(state.traceContext)
  ) {
    return undefined;
  }
  const traceContext = state.traceContext;
  if (!isString(traceContext.traceparent)) return undefined;
  return {
    runId: state.runId,
    featureId: state.featureId,
    sensitivity: 'standard',
    correlationId: state.correlationId,
    model: state.model,
    state: state.state,
    connection: state.connection,
    ...(isCopilotTerminalState(state.terminalState)
      ? { terminalState: state.terminalState }
      : {}),
    ...(state.cleanupPending === true ? { cleanupPending: true as const } : {}),
    ...(state.cleanupFailure === true ? { cleanupFailure: true as const } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    traceContext: {
      traceparent: traceContext.traceparent,
      ...(isString(traceContext.tracestate)
        ? { tracestate: traceContext.tracestate }
        : {}),
    },
    ownerId: state.ownerId,
    leaseExpiresAt: state.leaseExpiresAt,
    revision: state.revision,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export class DurableCopilotRunStore implements CopilotRunStore {
  constructor(private readonly durableRuns: DurableAiRunRepository) {}

  async get(runId: string): Promise<CopilotRunRecord | undefined> {
    const run = await this.durableRuns.getInternalRun(runId);
    if (!run?.executionState) return undefined;
    const providerSession = await this.durableRuns.getProviderSession(runId);
    return parseRecord(
      run.executionState,
      providerSession?.provider === COPILOT_PROVIDER
        ? providerSession.reference
        : undefined,
    );
  }

  async list(): Promise<CopilotRunRecord[]> {
    const runs = await this.durableRuns.listInternalRunsByRoute(COPILOT_EXECUTION_ROUTE);
    const records = await Promise.all(runs.map((run) => this.get(run.id)));
    return records.filter((record): record is CopilotRunRecord => Boolean(record));
  }

  async create(record: CopilotRunRecord): Promise<boolean> {
    let run = await this.durableRuns.getInternalRun(record.runId);
    if (!run) {
      await this.durableRuns.createRun({
        id: record.runId,
        idempotencyKey: `copilot:${record.runId}`,
        featureId: record.featureId,
        sensitivity: record.sensitivity,
        executionRoute: COPILOT_EXECUTION_ROUTE,
        requestedProvider: COPILOT_PROVIDER,
        requestedModel: record.model,
        correlationId: record.correlationId,
        traceparent: record.traceContext.traceparent,
        tracestate: record.traceContext.tracestate,
        now: new Date(record.createdAt),
      });
      run = await this.durableRuns.getInternalRun(record.runId);
    }
    if (!run || run.executionState) return false;
    return this.durableRuns.initializeExecutionState(
      record.runId,
      recordState(record),
      {
        expectedRevision: run.revision,
        status: durableStatus(record.state, record.terminalState),
        traceparent: record.traceContext.traceparent,
        tracestate: record.traceContext.tracestate,
        owner: record.ownerId,
        leaseExpiresAt: new Date(record.leaseExpiresAt).toISOString(),
        ...(record.providerSessionId
          ? {
              providerSession: {
                provider: COPILOT_PROVIDER,
                reference: record.providerSessionId,
              },
            }
          : {}),
        now: new Date(record.updatedAt),
      },
    );
  }

  async compareAndSet(
    expectedRevision: number,
    record: CopilotRunRecord,
  ): Promise<boolean> {
    const run = await this.durableRuns.getInternalRun(record.runId);
    const current = parseRecord(run?.executionState ?? null);
    if (!run || !current || current.revision !== expectedRevision) return false;
    const status = durableStatus(record.state, record.terminalState);
    const guard = transitionGuard(status);
    const now = new Date(record.updatedAt);
    let leaseGuard: {
      requiredLeaseOwner?: string;
      leaseState?: 'active' | 'expired';
    } = {};
    if (['running', 'cancelling'].includes(run.status)) {
      if (!run.leaseOwner || !run.leaseExpiresAt) return false;
      if (run.leaseOwner !== current.ownerId) return false;
      const expired = run.leaseExpiresAt <= now.toISOString();
      const sameOwner = record.ownerId === current.ownerId;
      if ((expired && sameOwner) || (!expired && !sameOwner)) return false;
      leaseGuard = {
        requiredLeaseOwner: run.leaseOwner,
        leaseState: expired ? 'expired' : 'active',
      };
    }
    const updated = await this.durableRuns.compareAndSetExecutionState(
      record.runId,
      run.revision,
      recordState(record),
      {
        status,
        traceparent: record.traceContext.traceparent,
        tracestate: record.traceContext.tracestate,
        owner: ['running', 'cancelling'].includes(status)
          ? record.ownerId
          : null,
        leaseExpiresAt: ['running', 'cancelling'].includes(status)
          ? new Date(record.leaseExpiresAt).toISOString()
          : null,
        completedAt: ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)
          ? new Date(record.updatedAt).toISOString()
          : null,
        cleanupStatus: record.state === 'cleaned_up'
          ? 'completed'
          : record.cleanupFailure
            ? 'failed'
            : record.cleanupPending
              ? 'pending'
              : undefined,
        provider: COPILOT_PROVIDER,
        model: record.model,
        fallbackState: 'not_used',
        ...(record.providerSessionId
          ? {
              providerSession: {
                provider: COPILOT_PROVIDER,
                reference: record.providerSessionId,
              },
            }
          : {}),
        revokeProviderSession: record.state === 'cleaned_up',
        ...guard,
        ...leaseGuard,
        now,
      },
    );
    return updated;
  }
}

export class DurableCopilotEventSink implements HoustonRunEventSink {
  constructor(
    private readonly durableRuns: DurableAiRunRepository,
    private readonly ownerId: string,
  ) {}

  async emit(event: HoustonRunEvent): Promise<void> {
    await this.durableRuns.appendEventForExecutionOwner(event.runId, this.ownerId, {
      eventId: event.eventId,
      idempotencyKey: event.idempotencyKey,
      kind: event.kind,
      payload: { ...event },
      provider: event.provider.name,
      model: event.provider.model,
      fallbackState: 'not_used',
      now: new Date(event.observedAt),
    });
  }
}

export async function getDurableCopilotEventCursor(
  durableRuns: DurableAiRunRepository,
  runId: string,
): Promise<HoustonRunEventCursor | undefined> {
  const events: DurableAiRunEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await durableRuns.getEventsAfter(runId, cursor, 1_000);
    events.push(...page.filter((event) =>
      typeof event.payload.sequence === 'number'));
    if (page.length < 1_000) break;
    cursor = page.at(-1)!.cursor;
  }
  if (events.length === 0) return undefined;
  const last = events.at(-1)!;
  const payload = last.payload;
  if (typeof payload.sequence !== 'number') return undefined;
  const terminal = [...events].reverse().find((event) =>
    typeof event.payload.terminalState === 'string');
  const lastNative = [...events].reverse().find((event) => {
    const source = event.payload.source;
    return source !== null
      && isRecord(source)
      && source.boundary === 'sdk'
      && typeof event.payload.timestamp === 'string';
  });
  return {
    sequence: payload.sequence,
    parentEventId: typeof payload.eventId === 'string'
      ? payload.eventId
      : last.eventId,
    ...(terminal && isCopilotTerminalState(terminal.payload.terminalState)
      ? {
          terminalState: terminal.payload.terminalState,
        }
      : {}),
    ...(events.some((event) => event.kind === 'run.cleanup_started')
      ? { cleanupStarted: true }
      : {}),
    ...(lastNative && typeof lastNative.payload.timestamp === 'string'
      ? { lastNativeTimestamp: lastNative.payload.timestamp }
      : {}),
    seenIdempotencyKeys: await durableRuns.getEventIdempotencyKeys(runId),
  };
}

export function copilotRunInputFromDurableRun(
  run: ClaimedDurableAiRun,
): CreateCopilotRunInput {
  if (run.sensitivity !== 'standard') {
    throw new Error('Direct Copilot execution only accepts standard-sensitivity runs.');
  }
  if (!run.requestedModel || !run.traceparent) {
    throw new Error('The durable run is missing Copilot model or trace metadata.');
  }
  return {
    runId: run.id,
    featureId: run.featureId,
    sensitivity: run.sensitivity,
    correlationId: run.correlationId,
    model: run.requestedModel,
    traceContext: {
      traceparent: run.traceparent,
      ...(run.tracestate ? { tracestate: run.tracestate } : {}),
    },
  };
}

export async function createDurableCopilotPersistence(
  ownerId: string,
  durableRuns?: DurableAiRunRepository,
): Promise<{
  store: CopilotRunStore;
  eventSink: HoustonRunEventSink;
  primeEventCursor(runId: string): Promise<void>;
  eventCursor(runId: string): HoustonRunEventCursor | undefined;
}> {
  const repository = durableRuns ?? await getDurableAiRunRepository();
  const eventCursors = new Map<string, HoustonRunEventCursor | undefined>();
  return {
    store: new DurableCopilotRunStore(repository),
    eventSink: new DurableCopilotEventSink(repository, ownerId),
    primeEventCursor: async (runId) => {
      eventCursors.set(
        runId,
        await getDurableCopilotEventCursor(repository, runId),
      );
    },
    eventCursor: (runId) => {
      const cursor = eventCursors.get(runId);
      eventCursors.delete(runId);
      return cursor;
    },
  };
}
