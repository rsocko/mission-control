import type Database from 'better-sqlite3';
import fs from 'fs';
import type { DatabaseBootstrapAdapter } from './contracts';
import { _runMigrationsIndividually } from './sqlite-migrations';
import {
  backfillTaskFieldStates,
  backfillTasksLastSyncedAt,
  repairTaskLinkedSourceDuplicates,
} from './repairs/task-sync';
import { _repairInboundWebhookNotificationActions } from './repairs/inbound-webhook';
import { applyTaskSyncTableSafetyNets, applyTaskLinkedSourceIdentitySafetyNet } from './safety-nets/task-sync';
import { applyInboundWebhookSafetyNets } from './safety-nets/inbound-webhooks';
import { applyResetSafetyNets } from './safety-nets/resets';
import { applyNotificationSafetyNets } from './safety-nets/notifications';
import {
  applyCoreQueryIndexSafetyNets,
  applySecondaryQueryIndexSafetyNets,
} from './safety-nets/query-indexes';
import { applyTagUnificationColumnSafetyNet, applyTaskSafetyNets } from './safety-nets/tasks';
import { applyTaskActivitySafetyNets } from './safety-nets/task-activity';
import { applyNotificationDeliverySafetyNets } from './safety-nets/notification-delivery';
import {
  applyConnectorConfigDeletedAtSafetyNet,
  applyConnectorSourceListColumnSafetyNets,
  applyConnectorSyncLogColumnSafetyNets,
  applyListGroupTableSafetyNet,
} from './safety-nets/connectors';
import { applyTriageColumnSafetyNets, applyTriageTableSafetyNets } from './safety-nets/triage';
import {
  applyProductivityTableSafetyNets,
  applySubtaskTemplateColumnSafetyNets,
} from './safety-nets/productivity';
import {
  applyHubProjectColumnSafetyNets,
  applyProjectHierarchyTableSafetyNets,
  applyProjectPhaseColumnSafetyNets,
} from './safety-nets/projects';
import { applyAlertColumnSafetyNets } from './safety-nets/alerts';
import { applySyncDeletionSafetyNets } from './safety-nets/sync-deletion';

export interface DatabaseBootstrapStep {
  readonly id: string;
  run(sqlite: Database.Database): void;
}

export function createOrderedBootstrapSteps(
  migrationsFolder: string,
): readonly DatabaseBootstrapStep[] {
  return [
    {
      id: 'migrations',
      run: (sqlite) => {
        if (fs.existsSync(migrationsFolder)) {
          _runMigrationsIndividually(sqlite, migrationsFolder);
        }
      },
    },
    { id: 'task-sync-tables', run: applyTaskSyncTableSafetyNets },
    { id: 'repair-task-linked-source-duplicates', run: repairTaskLinkedSourceDuplicates },
    { id: 'task-linked-source-identity', run: applyTaskLinkedSourceIdentitySafetyNet },
    { id: 'backfill-task-field-states', run: backfillTaskFieldStates },
    { id: 'list-group-table', run: applyListGroupTableSafetyNet },
    { id: 'triage-tables', run: applyTriageTableSafetyNets },
    { id: 'productivity-tables', run: applyProductivityTableSafetyNets },
    { id: 'project-hierarchy-tables', run: applyProjectHierarchyTableSafetyNets },
    { id: 'inbound-webhook-safety-nets', run: applyInboundWebhookSafetyNets },
    { id: 'reset-safety-nets', run: applyResetSafetyNets },
    { id: 'notification-safety-nets', run: applyNotificationSafetyNets },
    { id: 'core-query-indexes', run: applyCoreQueryIndexSafetyNets },
    { id: 'tag-unification-column', run: applyTagUnificationColumnSafetyNet },
    { id: 'secondary-query-indexes', run: applySecondaryQueryIndexSafetyNets },
    { id: 'connector-config-soft-delete', run: applyConnectorConfigDeletedAtSafetyNet },
    { id: 'connector-source-list-columns', run: applyConnectorSourceListColumnSafetyNets },
    { id: 'hub-project-columns', run: applyHubProjectColumnSafetyNets },
    { id: 'task-safety-nets', run: applyTaskSafetyNets },
    { id: 'backfill-tasks-last-synced-at', run: backfillTasksLastSyncedAt },
    { id: 'alert-columns', run: applyAlertColumnSafetyNets },
    { id: 'subtask-template-columns', run: applySubtaskTemplateColumnSafetyNets },
    { id: 'connector-sync-log-columns', run: applyConnectorSyncLogColumnSafetyNets },
    { id: 'project-phase-columns', run: applyProjectPhaseColumnSafetyNets },
    { id: 'triage-columns', run: applyTriageColumnSafetyNets },
    { id: 'task-activity-safety-nets', run: applyTaskActivitySafetyNets },
    { id: 'notification-delivery-safety-nets', run: applyNotificationDeliverySafetyNets },
    { id: 'sync-deletion-safety-nets', run: applySyncDeletionSafetyNets },
    { id: 'repair-inbound-webhook-actions', run: _repairInboundWebhookNotificationActions },
  ];
}

export function runOrderedDatabaseBootstrap(
  sqlite: Database.Database,
  migrationsFolder: string,
): void {
  for (const step of createOrderedBootstrapSteps(migrationsFolder)) {
    step.run(sqlite);
  }
}

export class SqliteDatabaseBootstrapAdapter implements DatabaseBootstrapAdapter {
  constructor(
    private readonly database: Database.Database,
    private readonly migrationsFolder: string,
  ) {}

  async initialize(): Promise<void> {
    this.initializeSync();
  }

  initializeSync(): void {
    runOrderedDatabaseBootstrap(this.database, this.migrationsFolder);
  }
}
