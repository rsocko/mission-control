import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import logger from '@/lib/logger';
import { runtimeRelease } from '@/lib/runtime/release';

export type RuntimeLifecycleStatus = 'starting' | 'ready' | 'draining';
export type RuntimeOperationCategory =
  | 'export'
  | 'image-capture'
  | 'archive-import'
  | 'ai'
  | 'connector-sync'
  | 'other';

export interface RuntimeMemoryDiagnostics {
  sampledAt: string;
  rssBytes: number;
  rssHighWaterBytes: number;
  rssP95Bytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  containerCurrentBytes: number | null;
  containerLimitBytes: number | null;
  containerOomEvents: number | null;
  containerOomKillEvents: number | null;
  pressure: 'healthy' | 'warning' | 'critical' | 'unavailable';
}

export interface RuntimeLifecycleSnapshot {
  status: RuntimeLifecycleStatus;
  reason: string | null;
  startedAt: string;
  drainingAt: string | null;
  release: string | null;
  role: string;
  activeOperations: Record<string, number>;
  previousExit: RuntimeExitDiagnostics | null;
}

export interface RuntimeExitDiagnostics {
  recordedAt: string;
  role: string;
  release: string | null;
  reason: string;
  restartCount: number | null;
  activeOperations: Record<string, number>;
  memory: RuntimeMemoryDiagnostics | null;
}

interface ActiveOperation {
  category: RuntimeOperationCategory;
  controller: AbortController;
}

interface RuntimeLifecycleState {
  status: RuntimeLifecycleStatus;
  reason: string | null;
  startedAt: string;
  drainingAt: string | null;
  role: string;
  release: string | null;
  operations: Map<string, ActiveOperation>;
  memory: RuntimeMemoryDiagnostics | null;
  previousExit: RuntimeExitDiagnostics | null;
  configured: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
}

const GLOBAL_KEY = '__mc_runtime_lifecycle__';
const runtimeGlobal = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: RuntimeLifecycleState;
};
const state = runtimeGlobal[GLOBAL_KEY] ?? {
  status: 'starting',
  reason: null,
  startedAt: new Date().toISOString(),
  drainingAt: null,
  role: process.env.MC_PROCESS_ROLE ?? 'web',
  release: runtimeRelease,
  operations: new Map(),
  memory: null,
  previousExit: null,
  configured: false,
  readyTimer: null,
};
runtimeGlobal[GLOBAL_KEY] = state;

function diagnosticsPath(): string | null {
  if (process.env.MC_RUNTIME_DIAGNOSTICS_PATH) {
    return path.resolve(process.env.MC_RUNTIME_DIAGNOSTICS_PATH);
  }
  if (process.env.NODE_ENV !== 'production') return null;
  return path.join(path.dirname(process.env.MC_DB_PATH ?? '/app/data/mission-control.db'), 'runtime-exit.json');
}

function operationCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const operation of state.operations.values()) {
    counts[operation.category] = (counts[operation.category] ?? 0) + 1;
  }
  return counts;
}

function readPreviousExit(): RuntimeExitDiagnostics | null {
  const filePath = diagnosticsPath();
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RuntimeExitDiagnostics;
  } catch (error) {
    logger.warn({ err: error, filePath }, 'Could not read previous runtime exit diagnostics');
    return null;
  }
}

function configuredRestartCount(): number | null {
  const raw = process.env.MC_CONTAINER_RESTART_COUNT?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function persistExitDiagnostics(reason: string): void {
  const filePath = diagnosticsPath();
  if (!filePath) return;
  const diagnostics: RuntimeExitDiagnostics = {
    recordedAt: new Date().toISOString(),
    role: state.role,
    release: state.release,
    reason,
    restartCount: configuredRestartCount(),
    activeOperations: operationCounts(),
    memory: state.memory,
  };
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original diagnostics write failure.
    }
    logger.error({ err: error, filePath, reason }, 'Could not persist runtime exit diagnostics');
  }
}

export function configureRuntimeLifecycle(role = process.env.MC_PROCESS_ROLE ?? 'web'): void {
  state.role = role;
  state.release = runtimeRelease;
  if (state.configured) return;
  state.configured = true;
  state.previousExit = readPreviousExit();
  if (state.previousExit) {
    logger.warn(
      { previousExit: state.previousExit },
      'Previous runtime exit diagnostics recovered',
    );
  }
  process.prependOnceListener(
    'SIGTERM',
    () => beginRuntimeDrain('signal:SIGTERM'),
  );
  process.prependOnceListener(
    'SIGINT',
    () => beginRuntimeDrain('signal:SIGINT'),
  );
}

export function markRuntimeReady(): void {
  if (state.status !== 'starting') return;
  const previousMemoryCritical = state.previousExit?.reason === 'memory-critical'
    || state.previousExit?.memory?.pressure === 'critical';
  if (!previousMemoryCritical) {
    state.status = 'ready';
    return;
  }
  const stabilizationMs = Math.max(
    1_000,
    Number(process.env.MC_RESTART_STABILIZATION_MS) || 60_000,
  );
  state.readyTimer ??= setTimeout(() => {
    state.readyTimer = null;
    if (state.status === 'starting') state.status = 'ready';
  }, stabilizationMs);
  state.readyTimer.unref();
}

export function beginRuntimeDrain(
  reason: string,
  memory: RuntimeMemoryDiagnostics | null = state.memory,
): void {
  if (memory) state.memory = memory;
  if (state.status === 'draining') return;
  state.status = 'draining';
  state.reason = reason;
  state.drainingAt = new Date().toISOString();
  const activeOperations = operationCounts();
  if (state.readyTimer) clearTimeout(state.readyTimer);
  state.readyTimer = null;
  persistExitDiagnostics(reason);
  for (const operation of state.operations.values()) {
    operation.controller.abort(new Error(`Runtime is draining: ${reason}`));
  }
  logger.error(
    {
      activeOperations,
      reason,
      release: state.release,
      role: state.role,
      memory: state.memory,
    },
    'Runtime entered draining state',
  );
}

export function requestRuntimeRestart(
  reason: string,
  memory: RuntimeMemoryDiagnostics,
): void {
  beginRuntimeDrain(reason, memory);
  setImmediate(() => process.kill(process.pid, 'SIGTERM'));
}

export function recordRuntimeMemoryDiagnostics(memory: RuntimeMemoryDiagnostics): void {
  state.memory = memory;
  if (memory.pressure === 'warning' || memory.pressure === 'critical') {
    persistExitDiagnostics(
      memory.pressure === 'critical' ? 'memory-critical' : 'memory-warning',
    );
  }
}

export function startRuntimeOperation(category: RuntimeOperationCategory): {
  accepted: boolean;
  signal: AbortSignal;
  finish: () => void;
} {
  const id = randomUUID();
  const controller = new AbortController();
  if (state.status === 'draining') {
    controller.abort(new Error(`Runtime is draining: ${state.reason ?? 'shutdown'}`));
    return { accepted: false, signal: controller.signal, finish: () => undefined };
  }
  state.operations.set(id, { category, controller });
  return {
    accepted: true,
    signal: controller.signal,
    finish: () => {
      state.operations.delete(id);
    },
  };
}

export function getRuntimeLifecycleSnapshot(): RuntimeLifecycleSnapshot {
  return {
    status: state.status,
    reason: state.reason,
    startedAt: state.startedAt,
    drainingAt: state.drainingAt,
    release: state.release,
    role: state.role,
    activeOperations: operationCounts(),
    previousExit: state.previousExit,
  };
}

export function isRuntimeReady(): boolean {
  return state.status === 'ready';
}
