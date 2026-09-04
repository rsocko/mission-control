import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

export interface SearchIndexTask {
  id: string;
  title: string;
  description?: string | null;
  sourceListName?: string | null;
  connectorType?: string | null;
  status?: string | null;
  priority?: string | null;
  updatedAt?: string | null;
}

export interface SearchIndexAlert {
  id: string;
  title: string;
  body?: string | null;
  category?: string | null;
  severity?: string | null;
  isRead?: boolean | null;
  isActionable?: boolean | null;
  connectorType?: string | null;
  receivedAt?: string | null;
}

export interface LegacySearchIndexingService {
  warmUp(): Promise<void>;
  indexTask(task: SearchIndexTask): Promise<void>;
  removeTask(taskId: string): Promise<void>;
  indexAlert(alert: SearchIndexAlert): Promise<void>;
}

interface LegacySearchIndexingRegistry {
  selectedService: LegacySearchIndexingService | null;
}

const REGISTRY_KEY = 'mission-control.legacy-search-indexing-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): LegacySearchIndexingRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    selectedService: null,
  }));
}

export function registerLegacySearchIndexingService(
  service: LegacySearchIndexingService,
): void {
  assertCanRegisterLegacySearchIndexingService(service);
  registry().selectedService = service;
}

export function assertCanRegisterLegacySearchIndexingService(
  service: LegacySearchIndexingService,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const { selectedService } = registry();
  if (selectedService && selectedService !== service) {
    throw new Error('Legacy search indexing service is already selected');
  }
}

export function clearLegacySearchIndexingService(
  expectedService?: LegacySearchIndexingService,
): void {
  const state = registry();
  if (expectedService && state.selectedService !== expectedService) return;
  state.selectedService = null;
}

export function getLegacySearchIndexingService(): LegacySearchIndexingService {
  assertPersistenceCompositionAccessAllowed();
  const { selectedService } = registry();
  if (!selectedService) {
    throw new Error('Legacy search indexing service is unavailable for the selected backend');
  }
  return selectedService;
}
