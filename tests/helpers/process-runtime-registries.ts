const processRegistryKeys = [
  'mission-control.persistence-composition-lifecycle',
  'mission-control.core-persistence-registry',
  'mission-control.worker-persistence-registry',
  'mission-control.triage-persistence-registry',
  'mission-control.connector-runtime-registry',
  'mission-control.semantic-publication-registry',
  'mission-control.semantic-source-port-registry',
  'mission-control.keyword-search-registry',
  'mission-control.semantic-search-runtime',
  'mission-control.ai-enrichment-registry',
  'mission-control.mode-route-service-registry',
  'mission-control.database-runtime-registry',
  'mission-control.durable-ai-run-runtime-registry',
  'mission-control.legacy-search-indexing-registry',
  'mission-control.task-core-persistence-registry',
  'mission-control.task-core-persistence-registry.v2',
  'mission-control.sync-job-runtime-registry',
  'mission-control.connector-operation-lease-runtime-registry',
  'mission-control.sync-control-state-runtime-registry',
  'mission-control.connector-maintenance-lock-runtime-registry',
  'mission-control.sync-operator-control-runtime-registry',
  'mission-control.runtime-health-persistence-registry',
  'mission-control.runtime-telemetry-persistence-registry',
];

const preserveAcrossModuleResetKey = Symbol.for(
  'mission-control.test.preserve-process-runtime-registries-across-module-reset',
);

export function resetProcessRuntimeRegistries(): void {
  const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
  for (const key of processRegistryKeys) delete host[Symbol.for(key)];
}

export function shouldPreserveProcessRuntimeRegistriesAcrossModuleReset(): boolean {
  const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
  return host[preserveAcrossModuleResetKey] === true;
}

export function resetModulesPreservingProcessRuntimeRegistries(
  resetModules: () => void,
): void {
  const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
  host[preserveAcrossModuleResetKey] = true;
  try {
    resetModules();
  } finally {
    delete host[preserveAcrossModuleResetKey];
  }
}
