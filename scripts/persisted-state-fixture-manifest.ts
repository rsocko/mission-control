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
