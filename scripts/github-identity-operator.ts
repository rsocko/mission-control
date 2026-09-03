import { parseArgs } from 'node:util';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { connectorConfigs } from '@/db/schema';
import { initializeDatabaseWithRetry } from '@/db/startup';
import { shutdownRuntimeDatabase } from '@/db/runtime';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import {
  GitHubIssuesConnector,
  reconcileHistoricalGitHubIssueTransfer,
} from '@/lib/connectors/github-issues';
import { and, eq, isNull } from 'drizzle-orm';
import type { ConnectorConfig } from '@/types';
import {
  getGitHubIdentityStatus,
  recordGitHubIdentityException,
  reconcileInterruptedGitHubWriteCycle,
  inspectGitHubWriteOutcomes,
  resolveGitHubWriteOutcome,
  type GitHubWriteOutcomeReader,
} from '@/lib/external-identities';

/**
 * GitHub identity is permanently NodeID-first. There is no mode to enable, no
 * comparison evidence to inspect, and no rollback to locator identity, so this
 * tool only exposes status and durable write/transfer/exception recovery.
 */
export type Command =
  | 'status'
  | 'write-cycle-reconcile'
  | 'write-outcome-inspect'
  | 'write-outcome-resolve'
  | 'transfer-reconcile'
  | 'exception-accept'
  | 'exception-revoke';

const COMMANDS = new Set<Command>([
  'status',
  'write-cycle-reconcile',
  'write-outcome-inspect',
  'write-outcome-resolve',
  'transfer-reconcile',
  'exception-accept',
  'exception-revoke',
]);

/**
 * These five commands are the audited GitHub identity operator/recovery
 * surfaces that remain SQLite-only (see `GitHubIdentityOperatorPersistence`):
 * identity backfill/status, manual exception mutation, unknown-outcome
 * resolution, and interrupted write-cycle recovery. `transfer-reconcile`
 * (historical GitHub issue transfer) is a separate, already-portable
 * capability and is intentionally excluded from this set.
 */
const SQLITE_ONLY_COMMANDS = new Set<Command>([
  'status',
  'write-cycle-reconcile',
  'write-outcome-inspect',
  'write-outcome-resolve',
  'exception-accept',
  'exception-revoke',
]);

/**
 * Fail-closed guard for the audited SQLite-only operator/recovery commands.
 * This must run — and must be able to reject — before this module (or any
 * caller) evaluates `@/db`, `better-sqlite3`, or any other SQLite-coupled
 * module. It is pure (reads only `MC_DATABASE_BACKEND` via
 * `resolveDatabaseBackend`) and has no side effects of its own, so it is
 * safe to call as the very first statement of a command handler, ahead of
 * `initializeDatabaseWithRetry()` and ahead of the dynamic `import('@/db')`
 * inside `initializeGitHubOutcomeReader`.
 */
export function assertSqliteOnlyCommandSupported(command: Command): void {
  if (SQLITE_ONLY_COMMANDS.has(command) && resolveDatabaseBackend() === 'postgres') {
    throw new OperatorError(
      `Command '${command}' is an audited SQLite-only operator/recovery surface and is not `
        + 'supported when MC_DATABASE_BACKEND=postgres. This is a pre-existing, documented '
        + 'limitation, not a new restriction introduced by web/application PostgreSQL parity.',
      4,
    );
  }
}

function usage(): string {
  return `Usage:
  node --conditions=react-server dist/github-identity-operator.cjs status --connector <id> [--limit <1-100>]
  node --conditions=react-server dist/github-identity-operator.cjs write-cycle-reconcile --connector <id> --cycle <cycle-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key> --confirm-pre-dispatch
  node --conditions=react-server dist/github-identity-operator.cjs write-outcome-inspect --connector <id> [--cycle <cycle-id>] [--lease <lease-id>] [--limit <1-50>]
  node --conditions=react-server dist/github-identity-operator.cjs write-outcome-resolve --connector <id> --cycle <cycle-id> --lease <lease-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key> [--confirm-owner-stopped]
  node --conditions=react-server dist/github-identity-operator.cjs transfer-reconcile --connector <id> --source-local-id <task-id> --successor-local-id <task-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key>
  node --conditions=react-server dist/github-identity-operator.cjs exception-accept --connector <id> --local-id <task-id> --actor <actor> --reason <reason> --idempotency-key <key> [--confirm-authoritative-deletion]
  node --conditions=react-server dist/github-identity-operator.cjs exception-revoke --connector <id> --local-id <task-id> --actor <actor> --reason <reason> --idempotency-key <key>`;
}

async function main(): Promise<void> {
  const rawCommand = process.argv[2];
  if (rawCommand === '--help' || rawCommand === '-h' || rawCommand === undefined) {
    console.log(usage());
    return;
  }
  if (!COMMANDS.has(rawCommand as Command)) {
    throw new OperatorError(`Unsupported command: ${rawCommand}`, 2);
  }
  const command = rawCommand as Command;
  assertSqliteOnlyCommandSupported(command);
  await initializeDatabaseWithRetry();
  const { values } = parseArgs({
    args: process.argv.slice(3),
    strict: true,
    allowPositionals: false,
    options: {
      connector: { type: 'string' },
      limit: { type: 'string' },
      revision: { type: 'string' },
      actor: { type: 'string' },
      reason: { type: 'string' },
      'idempotency-key': { type: 'string' },
      'local-id': { type: 'string' },
      'source-local-id': { type: 'string' },
      'successor-local-id': { type: 'string' },
      cycle: { type: 'string' },
      lease: { type: 'string' },
      'confirm-authoritative-deletion': { type: 'boolean', default: false },
      'confirm-pre-dispatch': { type: 'boolean', default: false },
      'confirm-owner-stopped': { type: 'boolean', default: false },
    },
  });
  const connectorInstanceId = required(values.connector, '--connector');
  if (command !== 'transfer-reconcile') {
    rejectDefined(values['source-local-id'], '--source-local-id');
    rejectDefined(values['successor-local-id'], '--successor-local-id');
  }

  if (command === 'write-outcome-inspect') {
    rejectOutcomeInspectionMutationOptions(values);
    const limit = values.limit === undefined ? undefined : parsePositiveInteger(values.limit, '--limit');
    if (limit !== undefined && limit > 50) {
      throw new OperatorError('--limit must not exceed 50 for write-outcome-inspect', 2);
    }
    print(await inspectGitHubWriteOutcomes({
      connectorInstanceId,
      cycleId: values.cycle,
      leaseId: values.lease,
      limit,
    }));
    return;
  }

  if (command === 'status') {
    rejectMutationOptions(values);
    const limit = values.limit === undefined ? undefined : parsePositiveInteger(values.limit, '--limit');
    print(await getGitHubIdentityStatus(connectorInstanceId, { limit }));
    return;
  }
  const actor = required(values.actor, '--actor');
  const reason = required(values.reason, '--reason');
  const idempotencyKey = required(values['idempotency-key'], '--idempotency-key');
  if (command === 'transfer-reconcile') {
    rejectDefined(values.limit, '--limit');
    rejectDefined(values['local-id'], '--local-id');
    rejectDefined(values.cycle, '--cycle');
    rejectDefined(values.lease, '--lease');
    if (
      values['confirm-authoritative-deletion']
      || values['confirm-pre-dispatch']
      || values['confirm-owner-stopped']
    ) {
      throw new OperatorError(
        'Unrelated confirmation flags are not valid for transfer-reconcile',
        2,
      );
    }
    print(await reconcileHistoricalGitHubIssueTransfer({
      connectorInstanceId,
      sourceTaskId: required(values['source-local-id'], '--source-local-id'),
      successorTaskId: required(values['successor-local-id'], '--successor-local-id'),
      expectedRevision: parseNonNegativeInteger(
        required(values.revision, '--revision'),
        '--revision',
      ),
      actor,
      reason,
      idempotencyKey,
    }));
    return;
  }
  if (command === 'write-outcome-resolve') {
    rejectDefined(values.limit, '--limit');
    rejectDefined(values['local-id'], '--local-id');
    if (values['confirm-authoritative-deletion'] || values['confirm-pre-dispatch']) {
      throw new OperatorError('Unrelated confirmation flags are not valid for write-outcome-resolve', 2);
    }
    const reader: GitHubWriteOutcomeReader = {
      async readGitHubWriteOutcome(request) {
        const connector = await initializeGitHubOutcomeReader(connectorInstanceId);
        return connector.readGitHubWriteOutcome(request);
      },
    };
    const result = await resolveGitHubWriteOutcome({
      connectorInstanceId,
      cycleId: required(values.cycle, '--cycle'),
      leaseId: required(values.lease, '--lease'),
      expectedRevision: parseNonNegativeInteger(
        required(values.revision, '--revision'),
        '--revision',
      ),
      actor,
      reason,
      idempotencyKey,
      confirmOwnerStopped: values['confirm-owner-stopped'],
    }, reader);
    if (!result.ok) {
      throw new OperatorError(
        `${result.code}: ${result.message}${result.remediation ? ` ${result.remediation}` : ''}`,
        3,
      );
    }
    print(result);
    return;
  }
  if (command === 'write-cycle-reconcile') {
    rejectDefined(values.lease, '--lease');
    rejectDefined(values['local-id'], '--local-id');
    rejectDefined(values.limit, '--limit');
    if (values['confirm-authoritative-deletion']) {
      throw new OperatorError(
        '--confirm-authoritative-deletion is not valid for write-cycle-reconcile',
        2,
      );
    }
    if (values['confirm-owner-stopped']) {
      throw new OperatorError('--confirm-owner-stopped is not valid for write-cycle-reconcile', 2);
    }
    if (!values['confirm-pre-dispatch']) {
      throw new OperatorError('write-cycle-reconcile requires --confirm-pre-dispatch', 3);
    }
    const result = await reconcileInterruptedGitHubWriteCycle({
      connectorInstanceId,
      cycleId: required(values.cycle, '--cycle'),
      expectedRevision: parseNonNegativeInteger(
        required(values.revision, '--revision'),
        '--revision',
      ),
      actor,
      reason,
      idempotencyKey,
      confirmPreDispatch: true,
    });
    if (!result.ok) throw new OperatorError(`${result.code}: ${result.message}`, 3);
    print(result);
    return;
  }

  rejectDefined(values.cycle, '--cycle');
  rejectDefined(values.lease, '--lease');
  rejectDefined(values.limit, '--limit');
  rejectDefined(values.revision, '--revision');
  if (values['confirm-pre-dispatch']) {
    throw new OperatorError('--confirm-pre-dispatch is not valid for exception commands', 2);
  }
  if (values['confirm-owner-stopped']) {
    throw new OperatorError('--confirm-owner-stopped is not valid for exception commands', 2);
  }
  if (command === 'exception-revoke' && values['confirm-authoritative-deletion']) {
    throw new OperatorError(
      '--confirm-authoritative-deletion is valid only for exception-accept',
      2,
    );
  }
  print(await recordGitHubIdentityException({
    connectorInstanceId,
    bindingType: 'task',
    localId: required(values['local-id'], '--local-id'),
    category: 'terminal_inaccessible',
    action: command === 'exception-accept' ? 'accept' : 'revoke',
    actor,
    reason,
    idempotencyKey,
    confirmAuthoritativeDeletion: values['confirm-authoritative-deletion'],
  }));
}

function rejectMutationOptions(values: Record<string, unknown>): void {
  for (const [key, flag] of [
    ['revision', '--revision'],
    ['actor', '--actor'],
    ['reason', '--reason'],
    ['idempotency-key', '--idempotency-key'],
    ['local-id', '--local-id'],
    ['cycle', '--cycle'],
    ['lease', '--lease'],
  ] as const) {
    rejectDefined(values[key], flag);
  }
  if (values['confirm-authoritative-deletion']) {
    throw new OperatorError(
      '--confirm-authoritative-deletion is not valid for read-only commands',
      2,
    );
  }
  if (values['confirm-pre-dispatch']) {
    throw new OperatorError('--confirm-pre-dispatch is not valid for read-only commands', 2);
  }
  if (values['confirm-owner-stopped']) {
    throw new OperatorError('--confirm-owner-stopped is not valid for read-only commands', 2);
  }
}

function rejectOutcomeInspectionMutationOptions(values: Record<string, unknown>): void {
  for (const [key, flag] of [
    ['revision', '--revision'],
    ['actor', '--actor'],
    ['reason', '--reason'],
    ['idempotency-key', '--idempotency-key'],
    ['local-id', '--local-id'],
  ] as const) {
    rejectDefined(values[key], flag);
  }
  if (
    values['confirm-owner-stopped']
    || values['confirm-authoritative-deletion']
    || values['confirm-pre-dispatch']
  ) {
    throw new OperatorError(
      'Confirmation flags are not valid for write-outcome-inspect',
      2,
    );
  }
}
async function initializeGitHubOutcomeReader(
  connectorInstanceId: string,
): Promise<GitHubIssuesConnector> {
  // Dynamic (not static) import: this keeps the SQLite driver from being
  // evaluated merely by loading this script module. Reachable only from the
  // `write-outcome-resolve` handler, which `assertSqliteOnlyCommandSupported`
  // has already fail-closed on PostgreSQL before this point is ever reached.
  const { default: db } = await import('@/db');
  const row = db.select().from(connectorConfigs).where(and(
    eq(connectorConfigs.id, connectorInstanceId),
    eq(connectorConfigs.type, 'github-issues'),
    eq(connectorConfigs.enabled, true),
    isNull(connectorConfigs.deletedAt),
  )).limit(1).get();
  if (!row) throw new Error('Enabled GitHub connector was not found');
  const connector = new GitHubIssuesConnector();
  await connector.initialize({
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    syncMode: row.syncMode as ConnectorConfig['syncMode'],
    pollIntervalMinutes: row.pollIntervalMinutes ?? undefined,
    capabilities: parseConnectorCapabilities(row.capabilities),
    credentials: parseStringRecord(row.credentials, 'credentials'),
    settings: parseJsonObject(row.settings),
    syncedLists: parseJsonArray(row.syncedLists),
  });
  return connector;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return (value as Record<string, unknown> | null) ?? {};
}

function parseJsonArray(value: unknown): string[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Connector synced lists are malformed');
  }
  return parsed;
}

function parseConnectorCapabilities(value: unknown): ConnectorConfig['capabilities'] {
  const parsed = parseJsonObject(value);
  const { read, write, delete: canDelete, sync, subtasks, lists, tags, tagWriteBack } = parsed;
  if (
    typeof read !== 'boolean'
    || typeof write !== 'boolean'
    || typeof canDelete !== 'boolean'
    || typeof sync !== 'boolean'
    || typeof subtasks !== 'boolean'
    || typeof lists !== 'boolean'
    || typeof tags !== 'boolean'
    || typeof tagWriteBack !== 'boolean'
  ) {
    throw new Error('Connector capabilities are malformed');
  }
  return {
    ...parsed,
    read,
    write,
    delete: canDelete,
    sync,
    subtasks,
    lists,
    tags,
    tagWriteBack,
  };
}

function parseStringRecord(value: unknown, field: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'string') throw new Error(`Connector ${field} are malformed`);
    result[key] = entry;
  }
  return result;
}

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new OperatorError(`${flag} is required`, 2);
  return value.trim();
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new OperatorError(`${flag} must be a positive integer`, 2);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OperatorError(`${flag} must be a non-negative integer`, 2);
  }
  return parsed;
}

function rejectDefined(value: unknown, flag: string): void {
  if (value !== undefined) throw new OperatorError(`${flag} is not valid for this command`, 2);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export class OperatorError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

// Guarded entrypoint invocation: only runs `main()` when this module is
// executed directly (not when imported, e.g. by tests exercising
// `assertSqliteOnlyCommandSupported` in isolation).
//
// Two module formats reach this line, so both are checked:
//  - The esbuild-bundled production CLI artifact
//    (`dist/github-identity-operator.cjs`, `format: 'cjs'`) is real CommonJS
//    at runtime: Node's canonical `require.main === module` idiom identifies
//    the entry script reliably there.
//  - The raw TypeScript source, imported directly by
//    `github-identity-operator-pg-guard.test.ts` (via Vitest/Vite's ESM
//    module graph) or run ad hoc via `tsx`, has no `require`/`module`
//    globals; `typeof require` safely detects their absence (it never
//    throws for an unbound identifier) and falls back to the
//    `import.meta.url` comparison, which is only true for actual direct
//    execution, never for a plain `import()`.
const isDirectCliInvocation = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module
  : Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectCliInvocation) {
  main()
    .catch((error: unknown) => {
      const operatorError = error instanceof OperatorError ? error : null;
      console.error(operatorError?.message ?? (error instanceof Error ? error.message : String(error)));
      if (operatorError?.exitCode === 2) console.error(usage());
      process.exitCode = operatorError?.exitCode ?? 1;
    })
    .finally(() => shutdownRuntimeDatabase());
}
