import type Database from 'better-sqlite3';
import {
  isPromiseLike,
  type SynchronousTransactionResult,
  type SynchronousTransactionRunner,
  type TransactionOptions,
  UnsupportedTransactionWorkError,
} from './contracts';

export class SqliteTransactionRunner
implements SynchronousTransactionRunner<Database.Database> {
  constructor(private readonly database: Database.Database) {}

  async run<TResult>(
    work: (
      database: Database.Database,
    ) => SynchronousTransactionResult<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const transaction = this.database.transaction(() => {
      const result = work(this.database);
      if (isPromiseLike(result)) {
        throw new UnsupportedTransactionWorkError(
          'SQLite transaction work must complete synchronously before yielding',
        );
      }
      return result;
    });

    const result = options.access === 'read'
      ? transaction.deferred()
      : transaction.immediate();
    return result;
  }
}
