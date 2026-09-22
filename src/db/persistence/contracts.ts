export type PersistenceId = string;
export type PersistenceTimestamp = string;

export type PersistenceJson =
  | null
  | boolean
  | number
  | string
  | PersistenceJson[]
  | { [key: string]: PersistenceJson };

export interface PersistencePageRequest {
  cursor?: string;
  limit: number;
}

export interface PersistencePage<T> {
  items: T[];
  nextCursor: string | null;
}

export type RepositoryErrorCode =
  | 'conflict'
  | 'constraint'
  | 'not-found'
  | 'unavailable';

export class RepositoryError extends Error {
  constructor(
    readonly code: RepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RepositoryError';
  }
}

export interface TransactionOptions {
  access?: 'read' | 'write';
}

export type TransactionWork<TContext, TResult> = (
  context: TContext,
) => TResult | Promise<TResult>;

export type SynchronousTransactionResult<TResult> =
  TResult extends PromiseLike<unknown> ? never : TResult;

export interface TransactionRunner<TContext> {
  run<TResult>(
    work: TransactionWork<TContext, TResult>,
    options?: TransactionOptions,
  ): Promise<TResult>;
}

export interface SynchronousTransactionRunner<TContext> {
  run<TResult>(
    work: (
      context: TContext,
    ) => SynchronousTransactionResult<TResult>,
    options?: TransactionOptions,
  ): Promise<TResult>;
}

export interface PersistenceLifecycle {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface PersistenceBackend<TTransactionContext>
extends PersistenceLifecycle {
  readonly transactions: SynchronousTransactionRunner<TTransactionContext>;
}

export class UnsupportedTransactionWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedTransactionWorkError';
  }
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  ) && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}
