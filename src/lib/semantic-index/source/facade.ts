import type { SemanticSourcePort } from './contracts';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface SemanticSourcePortRegistry {
  selected: SemanticSourcePort | null;
}

const REGISTRY_KEY = 'mission-control.semantic-source-port-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): SemanticSourcePortRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selected: null,
  }));
}

/**
 * Publishes the authoritative-source read port selected by the composition root.
 */
export function registerSemanticSourcePort(port: SemanticSourcePort): void {
  assertPersistenceCompositionPublicationAllowed();
  const selected = registry().selected;
  if (selected && selected !== port) {
    throw new Error('Semantic source port is already registered');
  }
  registry().selected = port;
}

export function clearSemanticSourcePort(expectedPort?: SemanticSourcePort): void {
  const selected = registry().selected;
  if (expectedPort && selected !== expectedPort) return;
  registry().selected = null;
}

/** Compatibility hook for callers that reset semantic runtime state in tests. */
export function resetSemanticSourcePortForTests(): void {
  clearSemanticSourcePort();
}

export async function getSemanticSourcePort(): Promise<SemanticSourcePort> {
  assertPersistenceCompositionAccessAllowed();
  const selected = registry().selected;
  if (!selected) {
    throw new Error('Semantic source port has not been registered');
  }
  return selected;
}
