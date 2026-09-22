export const PERSISTED_STATE_FIXTURE_VERSION = 1;

export interface PersistedStateFixture {
  readonly id: string;
  readonly checkpointTag: string;
  readonly fileName: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly connectorId: string;
  readonly syncLogId: string;
  readonly settingKey: string;
  readonly searchToken: string;
  readonly notificationId?: string;
  readonly syncJobId?: string;
  readonly includesPreNodeIdCutoverState?: boolean;
  readonly includesHistoricalPriorityEntityLayout?: boolean;
  readonly includesHistoricalInboundWebhookLayout?: boolean;
  readonly includesProductionHistoricalLayouts?: boolean;
  readonly tasksHistoricalOrder?:
    | 'late-migrations-first'
    | 'released-runtime-first'
    | 'continuous-production'
    | 'status-after-reminder'
    | 'status-after-local-disposition'
    | 'status-after-push-count'
    | 'status-after-relative-reminders'
    | 'status-after-recurrence';
  readonly statusRuntimeAfterTag?: string;
  readonly retainedHistoricalMigrationRows?: number;
}

export const PERSISTED_STATE_FIXTURES: readonly PersistedStateFixture[] = [
  {
    id: 'v1-0000-baseline',
    checkpointTag: '0000_sweet_chameleon',
    fileName: 'v1-0000-sweet-chameleon.sqlite3',
    taskId: 'fixture-task-0000',
    projectId: 'fixture-project-0000',
    connectorId: 'fixture-connector-0000',
    syncLogId: 'fixture-sync-log-0000',
    settingKey: 'fixture.setting.0000',
    searchToken: 'quartzbaseline',
  },
  {
    id: 'v1-0020-continuous-production-tasks',
    checkpointTag: '0047_isolate_sync_worker',
    fileName: 'v1-0020-continuous-production-tasks.sqlite3',
    taskId: 'fixture-task-0020-continuous',
    projectId: 'fixture-project-0020-continuous',
    connectorId: 'fixture-connector-0020-continuous',
    syncLogId: 'fixture-sync-log-0020-continuous',
    settingKey: 'fixture.setting.0020.continuous',
    searchToken: 'indigocontinuous',
    notificationId: 'fixture-notification-0020-continuous',
    syncJobId: 'fixture-sync-job-0020-continuous',
    includesHistoricalPriorityEntityLayout: true,
    includesHistoricalInboundWebhookLayout: true,
    includesProductionHistoricalLayouts: true,
    tasksHistoricalOrder: 'continuous-production',
    statusRuntimeAfterTag: '0020_add_task_effort',
    retainedHistoricalMigrationRows: 101,
  },
  {
    id: 'v1-0022-status-after-reminder',
    checkpointTag: '0047_isolate_sync_worker',
    fileName: 'v1-0022-status-after-reminder.sqlite3',
    taskId: 'fixture-task-0022-status',
    projectId: 'fixture-project-0022-status',
    connectorId: 'fixture-connector-0022-status',
    syncLogId: 'fixture-sync-log-0022-status',
    settingKey: 'fixture.setting.0022.status',
    searchToken: 'violetreminder',
    notificationId: 'fixture-notification-0022-status',
    syncJobId: 'fixture-sync-job-0022-status',
    includesHistoricalPriorityEntityLayout: true,
    includesHistoricalInboundWebhookLayout: true,
    includesProductionHistoricalLayouts: true,
    tasksHistoricalOrder: 'status-after-reminder',
    statusRuntimeAfterTag: '0022_add_task_reminder',
    retainedHistoricalMigrationRows: 101,
  },
  {
    id: 'v1-0047-durable-sync-queue',
    checkpointTag: '0047_isolate_sync_worker',
    fileName: 'v1-0047-isolate-sync-worker.sqlite3',
    taskId: 'fixture-task-0047',
    projectId: 'fixture-project-0047',
    connectorId: 'fixture-connector-0047',
    syncLogId: 'fixture-sync-log-0047',
    settingKey: 'fixture.setting.0047',
    searchToken: 'cobaltqueue',
    notificationId: 'fixture-notification-0047',
    syncJobId: 'fixture-sync-job-0047',
    includesHistoricalPriorityEntityLayout: true,
    includesHistoricalInboundWebhookLayout: true,
    includesProductionHistoricalLayouts: true,
    tasksHistoricalOrder: 'late-migrations-first',
    statusRuntimeAfterTag: '0027_add_bulk_import_flag',
    retainedHistoricalMigrationRows: 101,
  },
  {
    id: 'v1-0047-released-runtime-tasks',
    checkpointTag: '0047_isolate_sync_worker',
    fileName: 'v1-0047-released-runtime-tasks.sqlite3',
    taskId: 'fixture-task-0047-runtime',
    projectId: 'fixture-project-0047-runtime',
    connectorId: 'fixture-connector-0047-runtime',
    syncLogId: 'fixture-sync-log-0047-runtime',
    settingKey: 'fixture.setting.0047.runtime',
    searchToken: 'saffronruntime',
    notificationId: 'fixture-notification-0047-runtime',
    syncJobId: 'fixture-sync-job-0047-runtime',
    includesHistoricalPriorityEntityLayout: true,
    includesHistoricalInboundWebhookLayout: true,
    includesProductionHistoricalLayouts: true,
    tasksHistoricalOrder: 'released-runtime-first',
    retainedHistoricalMigrationRows: 101,
  },
  {
    id: 'v1-0053-status-after-local-disposition',
    checkpointTag: '0047_isolate_sync_worker',
    fileName: 'v1-0053-status-after-local-disposition.sqlite3',
    taskId: 'fixture-task-0053-status',
    projectId: 'fixture-project-0053-status',
    connectorId: 'fixture-connector-0053-status',
    syncLogId: 'fixture-sync-log-0053-status',
    settingKey: 'fixture.setting.0053.status',
    searchToken: 'copperdisposition',
    notificationId: 'fixture-notification-0053-status',
    syncJobId: 'fixture-sync-job-0053-status',
    includesHistoricalPriorityEntityLayout: true,
    includesHistoricalInboundWebhookLayout: true,
    includesProductionHistoricalLayouts: true,
    tasksHistoricalOrder: 'status-after-local-disposition',
    statusRuntimeAfterTag: '0053_add_task_local_disposition',
    retainedHistoricalMigrationRows: 101,
  },
  {
    id: 'v1-0106-status-after-push-count',
    checkpointTag: '0047_isolate_sync_worker',
    fileName: 'v1-0106-status-after-push-count.sqlite3',
    taskId: 'fixture-task-0106-status',
    projectId: 'fixture-project-0106-status',
    connectorId: 'fixture-connector-0106-status',
    syncLogId: 'fixture-sync-log-0106-status',
    settingKey: 'fixture.setting.0106.status',
    searchToken: 'silverpushcount',
    notificationId: 'fixture-notification-0106-status',
    syncJobId: 'fixture-sync-job-0106-status',
    includesHistoricalPriorityEntityLayout: true,
    includesHistoricalInboundWebhookLayout: true,
    includesProductionHistoricalLayouts: true,
    tasksHistoricalOrder: 'status-after-push-count',
    statusRuntimeAfterTag: '0106_task-delay-insights',
    retainedHistoricalMigrationRows: 101,
  },
  {
    id: 'v1-0109-status-after-relative-reminders',
    checkpointTag: '0047_isolate_sync_worker',
    fileName: 'v1-0109-status-after-relative-reminders.sqlite3',
    taskId: 'fixture-task-0109-status',
    projectId: 'fixture-project-0109-status',
    connectorId: 'fixture-connector-0109-status',
    syncLogId: 'fixture-sync-log-0109-status',
    settingKey: 'fixture.setting.0109.status',
    searchToken: 'crimsonrelative',
    notificationId: 'fixture-notification-0109-status',
    syncJobId: 'fixture-sync-job-0109-status',
    includesHistoricalPriorityEntityLayout: true,
    includesHistoricalInboundWebhookLayout: true,
    includesProductionHistoricalLayouts: true,
    tasksHistoricalOrder: 'status-after-relative-reminders',
    statusRuntimeAfterTag: '0109_relative_task_reminders',
    retainedHistoricalMigrationRows: 101,
  },
  {
    id: 'v1-0111-status-after-recurrence',
    checkpointTag: '0047_isolate_sync_worker',
    fileName: 'v1-0111-status-after-recurrence.sqlite3',
    taskId: 'fixture-task-0111-status',
    projectId: 'fixture-project-0111-status',
    connectorId: 'fixture-connector-0111-status',
    syncLogId: 'fixture-sync-log-0111-status',
    settingKey: 'fixture.setting.0111.status',
    searchToken: 'emeraldrecurrence',
    notificationId: 'fixture-notification-0111-status',
    syncJobId: 'fixture-sync-job-0111-status',
    includesHistoricalPriorityEntityLayout: true,
    includesHistoricalInboundWebhookLayout: true,
    includesProductionHistoricalLayouts: true,
    tasksHistoricalOrder: 'status-after-recurrence',
    statusRuntimeAfterTag: '0111_completion_anchored_recurrence',
    retainedHistoricalMigrationRows: 101,
  },
  {
    id: 'v1-0104-pre-nodeid-cutover',
    checkpointTag: '0104_quick_sort_undo',
    fileName: 'v1-0104-quick-sort-undo.sqlite3',
    taskId: 'fixture-task-0104',
    projectId: 'fixture-project-0104',
    connectorId: 'fixture-connector-0104',
    syncLogId: 'fixture-sync-log-0104',
    settingKey: 'fixture.setting.0104',
    searchToken: 'ambercutover',
    notificationId: 'fixture-notification-0104',
    syncJobId: 'fixture-sync-job-0104',
    includesPreNodeIdCutoverState: true,
  },
] as const;
