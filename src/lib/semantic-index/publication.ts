import type { SemanticSourceEntityType } from './source/contracts';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { SemanticPublishResult } from './service';
import { registerSemanticPublicationService } from './publication-service';

async function publish(
  kind: 'upsert' | 'delete',
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult | void> {
  if (resolveDatabaseBackend() === 'postgres') {
    const { publishPackagedPostgresSemanticEntity } = await import(
      './packaged-worker-runtime'
    );
    return publishPackagedPostgresSemanticEntity(kind, entityType, entityId);
  }
  const { isSemanticIndexEnabled } = await import('./config');
  if (!isSemanticIndexEnabled()) return;
  const { publishSemanticDelete, publishSemanticUpsert } = await import('./runtime');
  if (kind === 'upsert') await publishSemanticUpsert(entityType, entityId);
  else await publishSemanticDelete(entityType, entityId);
}

export function publishSemanticEntityUpsert(
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult | void> {
  return publish('upsert', entityType, entityId);
}

export function publishSemanticEntityDelete(
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<SemanticPublishResult | void> {
  return publish('delete', entityType, entityId);
}

registerSemanticPublicationService({
  upsert: publishSemanticEntityUpsert,
  delete: publishSemanticEntityDelete,
});
