import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { connectorConfigs } from './connectors';
import { externalEntities } from './external-identities';
import { taskLinkedSources } from './tasks';

export const taskLinkedSourceEntities = pgTable('task_linked_source_entities', {
  linkedSourceId: text('linked_source_id')
    .primaryKey()
    .references(() => taskLinkedSources.id, { onDelete: 'cascade' }),
  connectorInstanceId: text('connector_instance_id')
    .notNull()
    .references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  externalEntityId: text('external_entity_id')
    .notNull()
    .references(() => externalEntities.id, { onDelete: 'cascade' }),
  verifiedAt: text('verified_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_task_linked_source_entities_connector_entity')
    .on(table.connectorInstanceId, table.externalEntityId),
  index('idx_task_linked_source_entities_entity').on(table.externalEntityId),
  index('idx_task_linked_source_entities_connector')
    .on(table.connectorInstanceId, table.linkedSourceId),
]);
