import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

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

let selectedService: LegacySearchIndexingService | null = null;

export function registerLegacySearchIndexingService(
  service: LegacySearchIndexingService,
): void {
  assertCanRegisterLegacySearchIndexingService(service);
  selectedService = service;
}

export function assertCanRegisterLegacySearchIndexingService(
  service: LegacySearchIndexingService,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (selectedService && selectedService !== service) {
    throw new Error('Legacy search indexing service is already selected');
  }
}

export function clearLegacySearchIndexingService(
  expectedService?: LegacySearchIndexingService,
): void {
  if (expectedService && selectedService !== expectedService) return;
  selectedService = null;
}

export function getLegacySearchIndexingService(): LegacySearchIndexingService {
  assertPersistenceCompositionAccessAllowed();
  if (!selectedService) {
    throw new Error('Legacy search indexing service is unavailable for the selected backend');
  }
  return selectedService;
}
