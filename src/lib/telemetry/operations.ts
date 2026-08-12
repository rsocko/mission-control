import { randomUUID } from 'node:crypto';

export type RuntimeOperationKind = 'request' | 'sync' | 'import' | 'export' | 'semantic-search';

export interface RuntimeOperation {
  id: string;
  kind: RuntimeOperationKind;
  name: string;
  startedAt: string;
  traceId?: string;
  routeFamily?: string;
  jobId?: string;
  connectorId?: string;
  phase?: string;
}

export interface RuntimeOperationSnapshot {
  active: RuntimeOperation[];
  activeExpensive: number;
  queuedExpensive: number;
}

interface OperationState {
  active: Map<string, RuntimeOperation>;
  queuedExpensive: number;
}

const GLOBAL_KEY = '__mc_runtime_operations__';
const operationGlobal = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: OperationState;
};
const state = operationGlobal[GLOBAL_KEY] ?? {
  active: new Map<string, RuntimeOperation>(),
  queuedExpensive: 0,
};
operationGlobal[GLOBAL_KEY] = state;

const EXPENSIVE_KINDS = new Set<RuntimeOperationKind>([
  'sync',
  'import',
  'export',
  'semantic-search',
]);

function safeLabel(value: string | undefined, maximum = 120): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[^a-zA-Z0-9_:/.-]/g, '_').slice(0, maximum);
  return normalized || undefined;
}

export function normalizeRouteFamily(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/u.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)) return ':id';
      if (/^[0-9a-f]{16,}$/iu.test(segment)) return ':id';
      return segment.slice(0, 48);
    })
    .join('/');
}

export function beginRuntimeOperation(
  operation: Omit<RuntimeOperation, 'id' | 'startedAt'>,
): () => void {
  const id = randomUUID();
  const record: RuntimeOperation = {
    id,
    kind: operation.kind,
    name: safeLabel(operation.name) ?? operation.kind,
    startedAt: new Date().toISOString(),
    traceId: safeLabel(operation.traceId, 64),
    routeFamily: operation.routeFamily
      ? normalizeRouteFamily(operation.routeFamily)
      : undefined,
    jobId: safeLabel(operation.jobId, 64),
    connectorId: safeLabel(operation.connectorId, 64),
    phase: safeLabel(operation.phase, 64),
  };
  state.active.set(id, record);
  return () => {
    state.active.delete(id);
  };
}

export async function withRuntimeOperation<T>(
  operation: Omit<RuntimeOperation, 'id' | 'startedAt'>,
  callback: () => T | Promise<T>,
): Promise<T> {
  const finish = beginRuntimeOperation(operation);
  try {
    return await callback();
  } finally {
    finish();
  }
}

export function setQueuedExpensiveOperations(count: number): void {
  state.queuedExpensive = Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function getRuntimeOperationSnapshot(): RuntimeOperationSnapshot {
  const allActive = [...state.active.values()];
  const active = allActive
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .slice(0, 32);
  return {
    active,
    activeExpensive: allActive.filter(
      (operation) => EXPENSIVE_KINDS.has(operation.kind),
    ).length,
    queuedExpensive: state.queuedExpensive,
  };
}
