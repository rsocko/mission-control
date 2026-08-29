import { boolean } from 'drizzle-orm/pg-core';
import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export type MaintenanceAgentRunStatus =
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const maintenanceAgentRuns = pgTable('maintenance_agent_runs', {
  id: text('id').primaryKey(),
  agentType: text('agent_type').notNull(),
  status: text('status').$type<MaintenanceAgentRunStatus>().notNull(),
  dryRun: boolean('dry_run').notNull().default(false),
  checkpointStart: text('checkpoint_start'),
  checkpointEnd: text('checkpoint_end'),
  scannedCount: integer('scanned_count').notNull().default(0),
  mutationCount: integer('mutation_count').notNull().default(0),
  hasMore: boolean('has_more').notNull().default(false),
  leaseExpiresAt: text('lease_expires_at').notNull(),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_maintenance_agent_runs_active')
    .on(table.agentType)
    .where(sql`${table.status} = 'running'`),
  index('idx_maintenance_agent_runs_resume')
    .on(table.agentType, table.dryRun, table.startedAt),
  index('idx_maintenance_agent_runs_history').on(table.startedAt),
]);
