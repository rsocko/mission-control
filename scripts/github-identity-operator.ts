import { parseArgs } from 'node:util';
import db, { runTransaction } from '@/db';
import { connectorConfigs } from '@/db/schema';
import {
  GitHubIssuesConnector,
  reconcileHistoricalGitHubIssueTransfer,
} from '@/lib/connectors/github-issues';
import { and, eq, isNull } from 'drizzle-orm';
import type { ConnectorConfig } from '@/types';
import {
  getGitHubIdentityComparisonStatus,
  getGitHubIdentityModeSnapshotInTransaction,
  enableGitHubStablePrimary,
  recordGitHubIdentityException,
  reconcileInterruptedGitHubWriteCycle,
  inspectGitHubWriteOutcomes,
  resolveGitHubWriteOutcome,
  reconcileGitHubComparisonCycle,
  rollbackGitHubStablePrimary,
  transitionGitHubIdentityMode,
  transitionGitHubIdentityModeInTransaction,
  type GitHubWriteOutcomeReader,
} from '@/lib/external-identities';

type Command =
  | 'status'
  | 'evidence'
  | 'observe-enable'
  | 'observe-pause'
  | 'stable-enable'
  | 'stable-rollback'
  | 'rollback-reenter'
  | 'write-cycle-reconcile'
  | 'write-outcome-inspect'
  | 'write-outcome-resolve'
  | 'comparison-cycle-reconcile'
  | 'transfer-reconcile'
  | 'exception-accept'
  | 'exception-revoke';

const COMMANDS = new Set<Command>([
  'status',
  'evidence',
  'observe-enable',
  'observe-pause',
  'stable-enable',
  'stable-rollback',
  'rollback-reenter',
  'write-cycle-reconcile',
  'write-outcome-inspect',
  'write-outcome-resolve',
  'comparison-cycle-reconcile',
  'transfer-reconcile',
  'exception-accept',
  'exception-revoke',
]);

function usage(): string {
  return `Usage:
  node --conditions=react-server dist/github-identity-operator.cjs status --connector <id> [--limit <1-100>]
  node --conditions=react-server dist/github-identity-operator.cjs evidence --connector <id> [--limit <1-100>]
  node --conditions=react-server dist/github-identity-operator.cjs observe-enable --connector <id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key> --stage-one-ready
  node --conditions=react-server dist/github-identity-operator.cjs observe-pause --connector <id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key>
  node --conditions=react-server dist/github-identity-operator.cjs stable-enable --connector <id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key>
  node --conditions=react-server dist/github-identity-operator.cjs stable-rollback --connector <id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key>
  node --conditions=react-server dist/github-identity-operator.cjs rollback-reenter --connector <id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key> --rollback-verified
  node --conditions=react-server dist/github-identity-operator.cjs write-cycle-reconcile --connector <id> --cycle <cycle-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key> --confirm-pre-dispatch
  node --conditions=react-server dist/github-identity-operator.cjs write-outcome-inspect --connector <id> [--cycle <cycle-id>] [--lease <lease-id>] [--limit <1-50>]
  node --conditions=react-server dist/github-identity-operator.cjs write-outcome-resolve --connector <id> --cycle <cycle-id> --lease <lease-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key> [--confirm-owner-stopped]
  node --conditions=react-server dist/github-identity-operator.cjs comparison-cycle-reconcile --connector <id> --run <run-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key> [--successor-run <run-id> --confirm-replacement | --confirm-revision-retired | --confirm-no-write]
  node --conditions=react-server dist/github-identity-operator.cjs transfer-reconcile --connector <id> --source-local-id <task-id> --successor-local-id <task-id> --revision <n> --actor <actor> --reason <reason> --idempotency-key <key>
  node --conditions=react-server dist/github-identity-operator.cjs exception-accept --connector <id> --local-id <task-id> --actor <actor> --reason <reason> --idempotency-key <key> [--comparison-run <run-id> --confirm-authoritative-deletion]
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
      'stage-one-ready': { type: 'boolean', default: false },
      'rollback-verified': { type: 'boolean', default: false },
      'local-id': { type: 'string' },
      'source-local-id': { type: 'string' },
      'successor-local-id': { type: 'string' },
      'comparison-run': { type: 'string' },
      run: { type: 'string' },
      'successor-run': { type: 'string' },
      cycle: { type: 'string' },
      lease: { type: 'string' },
      'confirm-authoritative-deletion': { type: 'boolean', default: false },
      'confirm-pre-dispatch': { type: 'boolean', default: false },
      'confirm-owner-stopped': { type: 'boolean', default: false },
      'confirm-replacement': { type: 'boolean', default: false },
      'confirm-revision-retired': { type: 'boolean', default: false },
      'confirm-no-write': { type: 'boolean', default: false },
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
    print(inspectGitHubWriteOutcomes({
      connectorInstanceId,
      cycleId: values.cycle,
      leaseId: values.lease,
      limit,
    }));
    return;
  }

  if (command === 'status' || command === 'evidence') {
    rejectMutationOptions(values);
    const limit = values.limit === undefined ? undefined : parsePositiveInteger(values.limit, '--limit');
    print(getGitHubIdentityComparisonStatus(connectorInstanceId, {
      limit,
      includeEvidence: command === 'evidence',
    }));
    return;
  }
  const actor = required(values.actor, '--actor');
  const reason = required(values.reason, '--reason');
  const idempotencyKey = required(values['idempotency-key'], '--idempotency-key');
  if (command === 'transfer-reconcile') {
    rejectDefined(values.limit, '--limit');
    rejectDefined(values['local-id'], '--local-id');
    rejectDefined(values['comparison-run'], '--comparison-run');
    rejectDefined(values.run, '--run');
    rejectDefined(values['successor-run'], '--successor-run');
    rejectDefined(values.cycle, '--cycle');
    rejectDefined(values.lease, '--lease');
    rejectComparisonConfirmationFlags(values, command);
    if (
      values['stage-one-ready']
      || values['rollback-verified']
      || values['confirm-authoritative-deletion']
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
  if (command === 'comparison-cycle-reconcile') {
    rejectDefined(values.cycle, '--cycle');
    rejectDefined(values.lease, '--lease');
    rejectDefined(values['local-id'], '--local-id');
    rejectDefined(values['comparison-run'], '--comparison-run');
    rejectDefined(values.limit, '--limit');
    if (
      values['stage-one-ready']
      || values['rollback-verified']
      || values['confirm-authoritative-deletion']
      || values['confirm-pre-dispatch']
      || values['confirm-owner-stopped']
    ) {
      throw new OperatorError(
        'Unrelated attestation flags are not valid for comparison-cycle-reconcile',
        2,
      );
    }
    const replacement = values['confirm-replacement'];
    const retire = values['confirm-revision-retired'];
    const noWrite = values['confirm-no-write'];
    if ([replacement, retire, noWrite].filter(Boolean).length !== 1) {
      throw new OperatorError(
        'comparison-cycle-reconcile requires exactly one reconciliation confirmation',
        3,
      );
    }
    const successorRunId = replacement
      ? required(values['successor-run'], '--successor-run')
      : undefined;
    if (retire) rejectDefined(values['successor-run'], '--successor-run');
    print(reconcileGitHubComparisonCycle({
      connectorInstanceId,
      runId: required(values.run, '--run'),
      expectedRevision: parseNonNegativeInteger(
        required(values.revision, '--revision'),
        '--revision',
      ),
      action: replacement
        ? 'replacement'
        : retire
          ? 'retire_revision'
          : 'resolve_no_write',
      successorRunId,
      actor,
      reason,
      idempotencyKey,
    }));
    return;
  }
  if (command === 'write-outcome-resolve') {
    rejectDefined(values.limit, '--limit');
    rejectDefined(values['local-id'], '--local-id');
    rejectDefined(values['comparison-run'], '--comparison-run');
    rejectDefined(values.run, '--run');
    rejectDefined(values['successor-run'], '--successor-run');
    rejectComparisonConfirmationFlags(values, command);
    if (
      values['stage-one-ready']
      || values['rollback-verified']
      || values['confirm-authoritative-deletion']
      || values['confirm-pre-dispatch']
    ) {
      throw new OperatorError('Confirmation and mode-attestation flags are not valid for write-outcome-resolve', 2);
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
    rejectDefined(values['comparison-run'], '--comparison-run');
    rejectDefined(values.run, '--run');
    rejectDefined(values['successor-run'], '--successor-run');
    rejectDefined(values.limit, '--limit');
    rejectComparisonConfirmationFlags(values, 'write-cycle-reconcile');
    if (values['stage-one-ready'] || values['rollback-verified']) {
      throw new OperatorError('Mode attestation flags are not valid for write-cycle-reconcile', 2);
    }
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
    const result = reconcileInterruptedGitHubWriteCycle({
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
  if (command === 'exception-accept' || command === 'exception-revoke') {
    rejectDefined(values.cycle, '--cycle');
    rejectDefined(values.lease, '--lease');
    rejectDefined(values.run, '--run');
    rejectDefined(values['successor-run'], '--successor-run');
    rejectDefined(values.limit, '--limit');
    rejectComparisonConfirmationFlags(values, command);
    if (values['confirm-pre-dispatch']) {
      throw new OperatorError('--confirm-pre-dispatch is not valid for exception commands', 2);
    }
    if (values['confirm-owner-stopped']) {
      throw new OperatorError('--confirm-owner-stopped is not valid for exception commands', 2);
    }
    rejectDefined(values.revision, '--revision');
    if (values['stage-one-ready']) {
      throw new OperatorError('--stage-one-ready is not valid for exception commands', 2);
    }
    if (values['rollback-verified']) {
      throw new OperatorError('--rollback-verified is not valid for exception commands', 2);
    }
    const comparisonRunId = values['comparison-run'] === undefined
      ? undefined
      : required(values['comparison-run'], '--comparison-run');
    if (
      command === 'exception-revoke'
      && (comparisonRunId || values['confirm-authoritative-deletion'])
    ) {
      throw new OperatorError(
        'Comparison proof options are valid only for exception-accept',
        2,
      );
    }
    if (
      command === 'exception-accept'
      && Boolean(comparisonRunId) !== values['confirm-authoritative-deletion']
    ) {
      throw new OperatorError(
        'Post-backfill acceptance requires both --comparison-run and --confirm-authoritative-deletion',
        2,
      );
    }
    const result = recordGitHubIdentityException({
      connectorInstanceId,
      bindingType: 'task',
      localId: required(values['local-id'], '--local-id'),
      category: 'terminal_inaccessible',
      action: command === 'exception-accept' ? 'accept' : 'revoke',
      actor,
      reason,
      idempotencyKey,
      comparisonRunId,
      confirmAuthoritativeDeletion: values['confirm-authoritative-deletion'],
    });
    print(result);
    return;
  }

  rejectDefined(values['local-id'], '--local-id');
  rejectDefined(values['comparison-run'], '--comparison-run');
  rejectDefined(values.cycle, '--cycle');
  rejectDefined(values.lease, '--lease');
  rejectDefined(values.run, '--run');
  rejectDefined(values['successor-run'], '--successor-run');
  rejectDefined(values.limit, '--limit');
  rejectComparisonConfirmationFlags(values, command);
  if (values['confirm-authoritative-deletion']) {
    throw new OperatorError(
      '--confirm-authoritative-deletion is valid only for exception-accept',
      2,
    );
  }
  if (values['confirm-pre-dispatch']) {
    throw new OperatorError(
      '--confirm-pre-dispatch is valid only for write-cycle-reconcile',
      2,
    );
  }
  if (values['confirm-owner-stopped']) {
    throw new OperatorError(
      '--confirm-owner-stopped is valid only for write-outcome-resolve',
      2,
    );
  }
  if (idempotencyKey.length > 192) {
    throw new OperatorError('--idempotency-key must not exceed 192 characters for mode commands', 2);
  }
  const expectedRevision = parseNonNegativeInteger(required(values.revision, '--revision'), '--revision');
  if (command === 'stable-enable' || command === 'stable-rollback') {
    if (values['stage-one-ready'] || values['rollback-verified']) {
      throw new OperatorError(
        `Attestation flags are not valid for ${command}; eligibility is read atomically`,
        2,
      );
    }
    const result = command === 'stable-enable'
      ? enableGitHubStablePrimary({
          connectorInstanceId,
          expectedRevision,
          actor,
          reason,
          idempotencyKey,
        })
      : rollbackGitHubStablePrimary({
          connectorInstanceId,
          expectedRevision,
          actor,
          reason,
          idempotencyKey,
        });
    if (!result.ok) throw new OperatorError(`${result.code}: ${result.message}`, 3);
    print(result);
    return;
  }
  if (command === 'rollback-reenter') {
    if (values['stage-one-ready']) {
      throw new OperatorError('--stage-one-ready is not valid for rollback-reenter', 2);
    }
    if (!values['rollback-verified']) {
      throw new OperatorError('rollback-reenter requires --rollback-verified', 3);
    }
    const result = transitionGitHubIdentityMode({
      connectorInstanceId,
      targetPhase: 'comparing',
      expectedRevision,
      stablePrimaryEnabled: false,
      actor,
      reason,
      idempotencyKey,
      gate: { code: 'rollback_verified', passed: true },
    });
    if (!result.ok) throw new OperatorError(`${result.code}: ${result.message}`, 3);
    print(result);
    return;
  }
  if (command === 'observe-enable' && !values['stage-one-ready']) {
    throw new OperatorError('observe-enable requires --stage-one-ready', 3);
  }
  if (command === 'observe-pause' && values['stage-one-ready']) {
    throw new OperatorError('--stage-one-ready is not valid for observe-pause', 2);
  }
  if (values['rollback-verified']) {
    throw new OperatorError('--rollback-verified is valid only for rollback-reenter', 2);
  }
  const result = command === 'observe-enable'
    ? enableObserveMode({
        connectorInstanceId,
        expectedRevision,
        actor,
        reason,
        idempotencyKey,
      })
    : transitionGitHubIdentityMode({
        connectorInstanceId,
        targetPhase: 'paused',
        expectedRevision,
        stablePrimaryEnabled: false,
        actor,
        reason,
        idempotencyKey,
        gate: { code: 'pause', passed: true },
      });
  if (!result.ok) {
    throw new OperatorError(`${result.code}: ${result.message}`, 3);
  }

  function enableObserveMode(input: {
    connectorInstanceId: string;
    expectedRevision: number;
    actor: string;
    reason: string;
    idempotencyKey: string;
  }) {
    return runTransaction((tx) => {
      const current = getGitHubIdentityModeSnapshotInTransaction(
        tx,
        input.connectorInstanceId,
      );
      let revision = input.expectedRevision;
      if (current.phase === 'paused') {
        const resumed = transitionGitHubIdentityModeInTransaction(tx, {
          connectorInstanceId: input.connectorInstanceId,
          targetPhase: 'backfilling',
          expectedRevision: revision,
          stablePrimaryEnabled: false,
          actor: input.actor,
          reason: input.reason,
          idempotencyKey: `${input.idempotencyKey}:resume`,
        });
        if (!resumed.ok) return resumed;
        revision = resumed.snapshot.modeRevision;
      }
      return transitionGitHubIdentityModeInTransaction(tx, {
        connectorInstanceId: input.connectorInstanceId,
        targetPhase: 'comparing',
        expectedRevision: revision,
        stablePrimaryEnabled: false,
        actor: input.actor,
        reason: input.reason,
        idempotencyKey: `${input.idempotencyKey}:observe`,
        gate: { code: 'stage_one_ready', passed: true },
      });
    });
  }
  print(result);
}

function rejectMutationOptions(values: Record<string, unknown>): void {
  for (const [key, flag] of [
    ['revision', '--revision'],
    ['actor', '--actor'],
    ['reason', '--reason'],
    ['idempotency-key', '--idempotency-key'],
    ['local-id', '--local-id'],
    ['comparison-run', '--comparison-run'],
    ['cycle', '--cycle'],
    ['lease', '--lease'],
    ['run', '--run'],
    ['successor-run', '--successor-run'],
  ] as const) {
    rejectDefined(values[key], flag);
  }
  if (values['stage-one-ready']) {
    throw new OperatorError('--stage-one-ready is not valid for read-only commands', 2);
  }
  if (values['rollback-verified']) {
    throw new OperatorError('--rollback-verified is not valid for read-only commands', 2);
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
  rejectComparisonConfirmationFlags(values, 'read-only commands');
}

function rejectOutcomeInspectionMutationOptions(values: Record<string, unknown>): void {
  for (const [key, flag] of [
    ['revision', '--revision'],
    ['actor', '--actor'],
    ['reason', '--reason'],
    ['idempotency-key', '--idempotency-key'],
    ['local-id', '--local-id'],
    ['comparison-run', '--comparison-run'],
    ['run', '--run'],
    ['successor-run', '--successor-run'],
  ] as const) {
    rejectDefined(values[key], flag);
  }
  if (values['confirm-owner-stopped']) {
    throw new OperatorError(
      '--confirm-owner-stopped is not valid for write-outcome-inspect',
      2,
    );
  }
  if (
    values['stage-one-ready']
    || values['rollback-verified']
    || values['confirm-authoritative-deletion']
    || values['confirm-pre-dispatch']
  ) {
    throw new OperatorError(
      'Confirmation and mode-attestation flags are not valid for write-outcome-inspect',
      2,
    );
  }
  rejectComparisonConfirmationFlags(values, 'write-outcome-inspect');
}

function rejectComparisonConfirmationFlags(
  values: Record<string, unknown>,
  command: string,
): void {
  if (
    values['confirm-replacement']
    || values['confirm-revision-retired']
    || values['confirm-no-write']
  ) {
    throw new OperatorError(
      `Comparison reconciliation flags are not valid for ${command}`,
      2,
    );
  }
}

async function initializeGitHubOutcomeReader(
  connectorInstanceId: string,
): Promise<GitHubIssuesConnector> {
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

class OperatorError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

main().catch((error: unknown) => {
  const operatorError = error instanceof OperatorError ? error : null;
  console.error(operatorError?.message ?? (error instanceof Error ? error.message : String(error)));
  if (operatorError?.exitCode === 2) console.error(usage());
  process.exitCode = operatorError?.exitCode ?? 1;
});
