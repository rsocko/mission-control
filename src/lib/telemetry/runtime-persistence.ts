import type { DatabaseTelemetrySnapshot } from './database';
import type {
  RuntimeMemoryValues,
  RuntimeMetrics,
  RuntimeRole,
  RuntimeTelemetryInstance,
  RuntimeTelemetryRecord,
  RuntimeTelemetrySample,
} from './runtime';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

export interface RuntimeInstanceRegistration {
  instanceId: string;
  role: RuntimeRole;
  pid: number;
  startedAt: string;
  restartCount: number | null;
  buildSha: string | null;
  runtimeMode: string;
  highWaterMetrics: RuntimeMemoryValues;
  restartReason: string;
}

export interface RuntimeTelemetryPersistParams {
  role: RuntimeRole;
  instanceId: string;
  pid: number;
  startedAt: string;
  metrics: RuntimeMetrics;
  resolutionSeconds: number;
  highWaterMetrics: RuntimeMemoryValues;
}

export interface RuntimeTelemetryStopParams {
  instanceId: string;
  reason: string;
  terminalMetrics: RuntimeMetrics;
}

export interface RuntimeTelemetryHistoryOptions {
  role?: RuntimeRole;
  since: string;
  limit?: number;
}

export interface RuntimeTelemetryMaintenanceOptions {
  retentionHours?: number;
  rawHours?: number;
  downsampleSeconds?: number;
}

export interface RuntimeTelemetryPersistence {
  getDatabaseTelemetry(): DatabaseTelemetrySnapshot | undefined;
  registerInstance(registration: RuntimeInstanceRegistration): Promise<void>;
  persist(params: RuntimeTelemetryPersistParams): Promise<void>;
  recordStop(params: RuntimeTelemetryStopParams): Promise<void>;
  maintainHistory(
    now?: Date,
    options?: RuntimeTelemetryMaintenanceOptions,
  ): Promise<void>;
  getCurrent(): Promise<RuntimeTelemetryRecord[]>;
  getHistory(options: RuntimeTelemetryHistoryOptions): Promise<RuntimeTelemetrySample[]>;
  getAlertHistory(hours: number): Promise<RuntimeTelemetrySample[]>;
  getInstances(hours: number): Promise<RuntimeTelemetryInstance[]>;
}

interface RuntimeTelemetryPersistenceRegistry {
  selected: RuntimeTelemetryPersistence | null;
}

const REGISTRY_KEY = 'mission-control.runtime-telemetry-persistence-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): RuntimeTelemetryPersistenceRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selected: null,
  }));
}

export function registerRuntimeTelemetryPersistence(
  persistence: RuntimeTelemetryPersistence,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const state = registry();
  if (state.selected && state.selected !== persistence) {
    throw new Error('Runtime telemetry persistence is already selected');
  }
  state.selected = persistence;
}

export function clearRuntimeTelemetryPersistence(
  persistence: RuntimeTelemetryPersistence,
): void {
  const state = registry();
  if (state.selected === persistence) state.selected = null;
}

export function getRegisteredRuntimeTelemetryPersistence():
  RuntimeTelemetryPersistence | null {
  return registry().selected;
}

export function getRuntimeTelemetryPersistence(): RuntimeTelemetryPersistence {
  assertPersistenceCompositionAccessAllowed();
  const persistence = registry().selected;
  if (!persistence) {
    throw new Error(
      'Runtime telemetry persistence has not been registered. Initialize the database '
      + 'runtime before using runtime telemetry.',
    );
  }
  return persistence;
}
