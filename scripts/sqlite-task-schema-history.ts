export const TASK_COLUMNS_THROUGH_EFFORT = [
  'id',
  'source_id',
  'connector_type',
  'connector_instance_id',
  'title',
  'description',
  'status',
  'priority',
  'due_date',
  'created_at',
  'updated_at',
  'completed_at',
  'parent_id',
  'depth',
  'is_checklist_item',
  'source_list_id',
  'source_list_name',
  'assignee',
  'metadata',
  'sync_status',
  'last_synced_at',
  'kanban_column',
  'kanban_order',
  'micro_status',
  'snoozed_until',
  'effort',
] as const;

interface TaskColumnAppendEvent {
  readonly columns: readonly string[];
  readonly provenance:
    | {
        readonly kind: 'migration';
        readonly tag: string;
        readonly path: string;
        readonly sha256: string;
        readonly firstReachableCommit: string;
      }
    | {
        readonly kind: 'runtime';
        readonly path: string;
        readonly sha256: string;
        readonly firstReachableCommits: readonly string[];
        readonly sourceMarkers: readonly string[];
      };
}

const TASK_SAFETY_NET_PROVENANCE = {
  kind: 'runtime',
  path: 'src/db/bootstrap/safety-nets/tasks.ts',
  sha256: '90bc2838da02700bb136d83b4173b0f51210c98187968245c7f80dccbe0ee2ae',
} as const;

export const TRUSTED_TASK_COLUMN_APPEND_EVENTS = {
  statusAndRetryRuntime: {
    columns: ['status_reason', 'push_retry_count'],
    provenance: {
      ...TASK_SAFETY_NET_PROVENANCE,
      firstReachableCommits: [
        'da25455524eb34d3852cbf5df736349822a7a453',
      ],
      sourceMarkers: [
        'ALTER TABLE tasks ADD COLUMN status_reason TEXT',
        'ALTER TABLE tasks ADD COLUMN push_retry_count INTEGER NOT NULL DEFAULT 0',
      ],
    },
  },
  reminderMigration: {
    columns: ['reminder_at'],
    provenance: {
      kind: 'migration',
      tag: '0022_add_task_reminder',
      path: 'drizzle/0022_add_task_reminder.sql',
      sha256: 'bd9630492509de04d03012f6cebdde2b93820e62a082a79851ae247a7f65d93e',
      firstReachableCommit: 'da25455524eb34d3852cbf5df736349822a7a453',
    },
  },
  bulkImportMigration: {
    columns: ['is_bulk_import'],
    provenance: {
      kind: 'migration',
      tag: '0027_add_bulk_import_flag',
      path: 'drizzle/0027_add_bulk_import_flag.sql',
      sha256: 'd5409fe5e32addc526dc9f82bc2993e5f0dfdf81fb3584c1da164083dcca71e9',
      firstReachableCommit: 'da25455524eb34d3852cbf5df736349822a7a453',
    },
  },
  localDispositionMigration: {
    columns: ['local_disposition'],
    provenance: {
      kind: 'migration',
      tag: '0053_add_task_local_disposition',
      path: 'drizzle/0053_add_task_local_disposition.sql',
      sha256: '6b7a4f99c683ae43bedced77e6278f96d5ae06afa490a47945b4aa29fe60dccc',
      firstReachableCommit: 'da25455524eb34d3852cbf5df736349822a7a453',
    },
  },
  localDispositionRuntime: {
    columns: ['local_disposition'],
    provenance: {
      ...TASK_SAFETY_NET_PROVENANCE,
      firstReachableCommits: ['da25455524eb34d3852cbf5df736349822a7a453'],
      sourceMarkers: ['ALTER TABLE tasks ADD COLUMN local_disposition TEXT NOT NULL DEFAULT'],
    },
  },
  delayInsightsMigration: {
    columns: ['push_count'],
    provenance: {
      kind: 'migration',
      tag: '0106_task-delay-insights',
      path: 'drizzle/0106_task-delay-insights.sql',
      sha256: '5dc062c3c518003347ca2dafc6ec18a7e3a3d324d5d42070e2dfc15f9b39835f',
      firstReachableCommit: '4f58892bff0b8e2de9c8aa0aeb0b5c7dade7d835',
    },
  },
  relativeRemindersMigration: {
    columns: ['reminder_relative', 'reminder_due_time'],
    provenance: {
      kind: 'migration',
      tag: '0109_relative_task_reminders',
      path: 'drizzle/0109_relative_task_reminders.sql',
      sha256: '5d76dc49980b4bc8cdd4c989d09c88d524f17eb7d0759097f78d8739e4123dc3',
      firstReachableCommit: 'fdbc79f11b5e7639cd5289acea02eedc802ec4a4',
    },
  },
  recurrenceMigration: {
    columns: ['recurrence_generated_from_task_id'],
    provenance: {
      kind: 'migration',
      tag: '0111_completion_anchored_recurrence',
      path: 'drizzle/0111_completion_anchored_recurrence.sql',
      sha256: '74fcc6637db58f6d776957faba4f6c171a8e0024a9332f5648a74b6924c33d29',
      firstReachableCommit: 'aa39b2d59c9a2e8181225e02a2e4eee8a7b71a25',
    },
  },
  recurrenceRuntime: {
    columns: ['recurrence_generated_from_task_id'],
    provenance: {
      ...TASK_SAFETY_NET_PROVENANCE,
      firstReachableCommits: ['aa39b2d59c9a2e8181225e02a2e4eee8a7b71a25'],
      sourceMarkers: ['ALTER TABLE tasks ADD COLUMN recurrence_generated_from_task_id TEXT'],
    },
  },
  planningHorizonMigration: {
    columns: ['planning_horizon'],
    provenance: {
      kind: 'migration',
      tag: '0118_add_planning_horizon',
      path: 'drizzle/0118_add_planning_horizon.sql',
      sha256: 'af4f003d9b26af32076f40f928863ff00e537ecec5c78fba736d85e0c3d3ad6c',
      firstReachableCommit: 'd4e9fc18644a439d80c81eaeae9da110123f5764',
    },
  },
  planningHorizonRuntime: {
    columns: ['planning_horizon'],
    provenance: {
      ...TASK_SAFETY_NET_PROVENANCE,
      firstReachableCommits: ['d4e9fc18644a439d80c81eaeae9da110123f5764'],
      sourceMarkers: ['ALTER TABLE tasks ADD COLUMN planning_horizon TEXT'],
    },
  },
} as const satisfies Readonly<Record<string, TaskColumnAppendEvent>>;

export const TRUSTED_TASK_APPEND_COLUMNS = [
  'micro_status',
  'snoozed_until',
  'effort',
  ...new Set(Object.values(TRUSTED_TASK_COLUMN_APPEND_EVENTS)
    .flatMap((event) => event.columns)),
] as const;

export type TrustedTasksChronologyId =
  | 'fresh'
  | 'late-migrations-first'
  | 'released-runtime-first'
  | 'continuous-production'
  | 'status-after-reminder'
  | 'status-after-local-disposition'
  | 'status-after-push-count'
  | 'status-after-relative-reminders'
  | 'status-after-recurrence';

interface TrustedTasksChronology {
  readonly id: TrustedTasksChronologyId;
  readonly origin: string;
  readonly events: readonly (keyof typeof TRUSTED_TASK_COLUMN_APPEND_EVENTS)[];
  readonly checkpointTags: readonly string[];
}

const ORDERED_MIGRATION_EVENTS = [
  'reminderMigration',
  'bulkImportMigration',
  'localDispositionMigration',
  'delayInsightsMigration',
  'relativeRemindersMigration',
  'recurrenceMigration',
  'planningHorizonMigration',
] as const satisfies readonly (keyof typeof TRUSTED_TASK_COLUMN_APPEND_EVENTS)[];

const STATUS_RUNTIME_BOUNDARIES = [
  {
    id: 'continuous-production',
    afterTag: '0020_add_task_effort',
  },
  {
    id: 'status-after-reminder',
    afterTag: '0022_add_task_reminder',
  },
  {
    id: 'late-migrations-first',
    afterTag: '0027_add_bulk_import_flag',
  },
  {
    id: 'status-after-local-disposition',
    afterTag: '0053_add_task_local_disposition',
  },
  {
    id: 'status-after-push-count',
    afterTag: '0106_task-delay-insights',
  },
  {
    id: 'status-after-relative-reminders',
    afterTag: '0109_relative_task_reminders',
  },
  {
    id: 'status-after-recurrence',
    afterTag: '0111_completion_anchored_recurrence',
  },
  {
    id: 'fresh',
    afterTag: '0118_add_planning_horizon',
  },
] as const;

const migrationBoundaryChronologies = STATUS_RUNTIME_BOUNDARIES.map(
  ({ id, afterTag }, boundaryIndex): TrustedTasksChronology => ({
    id,
    origin: `status/retry runtime after ${afterTag}`,
    checkpointTags: [afterTag, '0118_add_planning_horizon'],
    events: [
      ...ORDERED_MIGRATION_EVENTS.slice(0, boundaryIndex),
      'statusAndRetryRuntime',
      ...ORDERED_MIGRATION_EVENTS.slice(boundaryIndex),
    ],
  }),
);

export const TRUSTED_TASKS_CHRONOLOGIES: readonly TrustedTasksChronology[] = [
  ...migrationBoundaryChronologies,
  {
    id: 'released-runtime-first',
    origin: '0047 checkpoint runtime safety nets, recurrence/planning runtimes, then late migrations',
    checkpointTags: ['0047_isolate_sync_worker', '0109_relative_task_reminders'],
    events: [
      'reminderMigration',
      'bulkImportMigration',
      'statusAndRetryRuntime',
      'localDispositionRuntime',
      'recurrenceRuntime',
      'planningHorizonRuntime',
      'delayInsightsMigration',
      'relativeRemindersMigration',
    ],
  },
] as const;

function replayTaskColumnAppends(
  events: TrustedTasksChronology['events'],
): readonly string[] {
  const columns: string[] = [...TASK_COLUMNS_THROUGH_EFFORT];
  for (const event of events) {
    for (const column of TRUSTED_TASK_COLUMN_APPEND_EVENTS[event].columns) {
      if (!columns.includes(column)) columns.push(column);
    }
  }
  return columns;
}

export function deriveTrustedTasksColumnOrders(): ReadonlyMap<
  TrustedTasksChronologyId,
  readonly string[]
> {
  const orders = new Map<TrustedTasksChronologyId, readonly string[]>();
  const seen = new Set<string>();
  for (const chronology of TRUSTED_TASKS_CHRONOLOGIES) {
    const order = replayTaskColumnAppends(chronology.events);
    const key = JSON.stringify(order);
    if (seen.has(key)) {
      throw new Error(`Trusted tasks chronology ${chronology.id} duplicates another path.`);
    }
    seen.add(key);
    orders.set(chronology.id, order);
  }
  return orders;
}

export function trustedHistoricalTasksColumnOrders(): readonly (readonly string[])[] {
  return [...deriveTrustedTasksColumnOrders()]
    .filter(([id]) => id !== 'fresh')
    .map(([, order]) => order);
}
