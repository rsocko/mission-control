const processRegistryKeys = [
  'mission-control.persistence-composition-lifecycle',
  'mission-control.core-persistence-registry',
  'mission-control.worker-persistence-registry',
  'mission-control.triage-persistence-registry',
  'mission-control.connector-runtime-registry',
  'mission-control.semantic-publication-registry',
  'mission-control.keyword-search-registry',
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
];

export function resetProcessRuntimeRegistries(): void {
  const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
  for (const key of processRegistryKeys) delete host[Symbol.for(key)];
}
