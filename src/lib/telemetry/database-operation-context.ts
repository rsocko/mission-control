import { AsyncLocalStorage } from 'node:async_hooks';

export const DATABASE_OPERATION_NAMES = [
  'unattributed',
  'sync-queue-schedule',
  'sync-queue-count',
  'sync-queue-claim',
  'sync-job-lease',
  'sync-job-events',
  'sync-job-finalize',
  'sync-job-execution',
  'sync-phase-push',
  'sync-phase-domain-data',
  'sync-phase-remote-fetch',
  'sync-phase-lists',
  'sync-phase-tasks',
  'sync-phase-dependencies',
  'sync-phase-projects',
  'worker-health-snapshot',
  'worker-task-reminders',
  'worker-triage-import',
  'worker-finance-recovery',
] as const;

export type DatabaseOperationName = typeof DATABASE_OPERATION_NAMES[number];

const operationNames = new Set<string>(DATABASE_OPERATION_NAMES);
const operationContext = new AsyncLocalStorage<DatabaseOperationName>();

function isDatabaseOperationName(value: unknown): value is DatabaseOperationName {
  return typeof value === 'string' && operationNames.has(value);
}

function normalizeDatabaseOperationName(value: unknown): DatabaseOperationName {
  return isDatabaseOperationName(value) ? value : 'unattributed';
}

export function getCurrentDatabaseOperation(): DatabaseOperationName {
  return operationContext.getStore() ?? 'unattributed';
}

export function withDatabaseOperation<T>(
  operation: DatabaseOperationName,
  callback: () => T,
): T {
  return operationContext.run(normalizeDatabaseOperationName(operation), callback);
}
