import type { SemanticSourceEntityType } from './source/contracts';
import { isSemanticIndexEnabled } from './config';

async function publish(
  kind: 'upsert' | 'delete',
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<void> {
  if (!isSemanticIndexEnabled()) return;
  const { publishSemanticDelete, publishSemanticUpsert } = await import('./runtime');
  if (kind === 'upsert') await publishSemanticUpsert(entityType, entityId);
  else await publishSemanticDelete(entityType, entityId);
}

export function publishSemanticEntityUpsert(
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<void> {
  return publish('upsert', entityType, entityId);
}

export function publishSemanticEntityDelete(
  entityType: SemanticSourceEntityType,
  entityId: string,
): Promise<void> {
  return publish('delete', entityType, entityId);
}
