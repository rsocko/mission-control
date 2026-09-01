import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  ImportInvariantError,
  ImportPreconditionError,
  runSqliteToPostgresImport,
  type ImportLogger,
  type SqliteToPostgresImportOptions,
} from './lib/sqlite-to-postgres-import';

function usage(): string {
  return [
    'Usage:',
    '  npm run db:import:postgres -- --sqlite-source <path> --postgres-url <url> --confirm-writers-stopped [--dry-run]',
    '  npm run db:import:postgres -- --fixture <fixture-id> --postgres-url <url> --rehearsal [--reset-disposable-rehearsal-target]',
    '',
    'Options:',
    '  --sqlite-source <path>                  Retained SQLite source database to open read-only',
    '  --fixture <id>                          Synthetic persisted-state fixture id for rehearsal',
    '  --postgres-url <url>                    PostgreSQL target URL; may also use MC_POSTGRES_IMPORT_URL',
    '  --dry-run                               Validate source/target and print a copy plan without writing',
    '  --rehearsal                             Mark this as a rehearsal run',
    '  --reset-disposable-rehearsal-target     Drop/recreate public schema for clearly named rehearsal targets only',
    '  --confirm-writers-stopped               Required for real SQLite sources after stopping web and worker writers',
  ].join('\n');
}

function readOption(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new ImportPreconditionError(`Missing value for ${name}.`);
  }
  return value;
}

export function parseArgs(args: readonly string[]): SqliteToPostgresImportOptions {
  const options: SqliteToPostgresImportOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--sqlite-source':
        options.sqliteSourcePath = readOption(args, index, arg);
        index += 1;
        break;
      case '--fixture':
        options.fixtureId = readOption(args, index, arg);
        options.rehearsal = true;
        index += 1;
        break;
      case '--postgres-url':
        options.postgresUrl = readOption(args, index, arg);
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--rehearsal':
        options.rehearsal = true;
        break;
      case '--reset-disposable-rehearsal-target':
        options.resetDisposableRehearsalTarget = true;
        break;
      case '--confirm-writers-stopped':
        options.confirmWritersStopped = true;
        break;
      case '--help':
      case '-h':
        throw new Error(usage());
      default:
        throw new ImportPreconditionError(`Unknown option: ${arg}`);
    }
  }
  if (options.sqliteSourcePath && options.fixtureId) {
    throw new ImportPreconditionError('Pass only one source: --sqlite-source or --fixture.');
  }
  if (options.resetDisposableRehearsalTarget && !options.rehearsal) {
    throw new ImportPreconditionError(
      '--reset-disposable-rehearsal-target requires --rehearsal or --fixture.',
    );
  }
  return options;
}

const logger: ImportLogger = {
  info(message, fields = {}) {
    process.stdout.write(`${message} ${JSON.stringify(fields)}\n`);
  },
  warn(message, fields = {}) {
    process.stderr.write(`warning: ${message} ${JSON.stringify(fields)}\n`);
  },
  error(message, fields = {}) {
    process.stderr.write(`error: ${message} ${JSON.stringify(fields)}\n`);
  },
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runSqliteToPostgresImport({ ...options, logger });
  process.stdout.write(`summary ${JSON.stringify({
    dryRun: result.dryRun,
    rehearsal: result.rehearsal,
    sourceKind: result.sourceKind,
    sourceLabel: result.sourceLabel,
    copiedTables: result.copiedTables.length,
    copiedRows: result.copiedTables.reduce((sum, count) => sum + count.sourceRows, 0),
    initializedTarget: result.initializedTarget,
    resetDisposableTarget: result.resetDisposableTarget,
    evidence: result.evidence,
    invariants: result.invariants ? {
      allCopiedTableCountsMatch: result.invariants.allCopiedTableCountsMatch,
      taskSearchDocuments: result.invariants.taskSearchDocuments,
      notificationSearchDocuments: result.invariants.notificationSearchDocuments,
      orphanTaskProjects: result.invariants.orphanTaskProjects,
      orphanTaskDependencies: result.invariants.orphanTaskDependencies,
      orphanSyncJobEvents: result.invariants.orphanSyncJobEvents,
      orphanNotificationTasks: result.invariants.orphanNotificationTasks,
    } : undefined,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof ImportPreconditionError || error instanceof ImportInvariantError) {
      logger.error(error.message);
      process.exitCode = 1;
      return;
    }
    if (error instanceof Error && error.message.startsWith('Usage:')) {
      process.stdout.write(`${error.message}\n`);
      return;
    }
    logger.error(error instanceof Error ? error.message : 'Unknown import failure');
    process.exitCode = 1;
  });
}
