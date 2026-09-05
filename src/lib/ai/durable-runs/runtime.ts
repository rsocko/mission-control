import type { DurableAiRunRepository } from './repository';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface DurableAiRunRuntimeRegistry {
  selectedRepository: DurableAiRunRepository | null;
}

const REGISTRY_KEY = 'mission-control.durable-ai-run-runtime-registry';
const REGISTRY_SCHEMA_VERSION = 2;

function registry(): DurableAiRunRuntimeRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selectedRepository: null,
  }));
}

export function registerDurableAiRunRepository(
  repository: DurableAiRunRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const runtime = registry();
  if (runtime.selectedRepository && runtime.selectedRepository !== repository) {
    throw new Error('Durable AI run repository is already registered');
  }
  runtime.selectedRepository = repository;
}

export function clearDurableAiRunRepository(
  expectedRepository?: DurableAiRunRepository,
): void {
  const runtime = registry();
  if (expectedRepository && runtime.selectedRepository !== expectedRepository) return;
  runtime.selectedRepository = null;
}

export function getRegisteredDurableAiRunRepository(): DurableAiRunRepository | null {
  return registry().selectedRepository;
}

export async function getDurableAiRunRepository(): Promise<DurableAiRunRepository> {
  assertPersistenceCompositionAccessAllowed();
  const repository = registry().selectedRepository;
  if (!repository) {
    throw new Error('Durable AI run repository has not been registered');
  }
  return repository;
}
