#!/usr/bin/env tsx

import process from 'node:process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export type FinanceInsightCutoverCommand = 'readiness' | 'enable' | 'rollback';

export interface FinanceInsightCutoverCliOptions {
  command: FinanceInsightCutoverCommand;
  origin: string;
  connectorId: string;
  sourceGeneration: string;
  apiKey: string;
  idempotencyKey?: string;
}

export class FinanceInsightCutoverCliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'FinanceInsightCutoverCliError';
  }
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new FinanceInsightCutoverCliError(`${label} is required`, 2);
  return normalized;
}

function parseCommand(value: string | undefined): FinanceInsightCutoverCommand {
  if (value === 'readiness' || value === 'enable' || value === 'rollback') {
    return value;
  }
  throw new FinanceInsightCutoverCliError(
    'Command must be readiness, enable, or rollback',
    2,
  );
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FinanceInsightCutoverCliError('--origin must be an absolute URL', 2);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new FinanceInsightCutoverCliError(
      '--origin must be an HTTP(S) URL without embedded credentials',
      2,
    );
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new FinanceInsightCutoverCliError(
      '--origin must use HTTPS unless it targets loopback',
      2,
    );
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function parseFinanceInsightCutoverCli(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FinanceInsightCutoverCliOptions {
  const command = parseCommand(args[0]);
  const values = (() => {
    try {
      return parseArgs({
        args: [...args.slice(1)],
        options: {
          origin: { type: 'string' },
          connector: { type: 'string' },
          'source-generation': { type: 'string' },
          'idempotency-key': { type: 'string' },
        },
        strict: true,
      }).values;
    } catch (error) {
      throw new FinanceInsightCutoverCliError(
        error instanceof Error ? error.message : 'Invalid CLI arguments',
        2,
      );
    }
  })();

  const idempotencyKey = values['idempotency-key']?.trim();
  if (command !== 'readiness' && !idempotencyKey) {
    throw new FinanceInsightCutoverCliError(
      '--idempotency-key is required for enable and rollback',
      2,
    );
  }
  if (command === 'readiness' && idempotencyKey) {
    throw new FinanceInsightCutoverCliError(
      '--idempotency-key is only valid for enable and rollback',
      2,
    );
  }

  return {
    command,
    origin: normalizeOrigin(required(values.origin ?? environment.MC_ORIGIN, '--origin or MC_ORIGIN')),
    connectorId: required(values.connector, '--connector'),
    sourceGeneration: required(values['source-generation'], '--source-generation'),
    apiKey: required(environment.MC_API_KEY, 'MC_API_KEY'),
    idempotencyKey,
  };
}

function responseErrorCode(value: unknown): string {
  if (
    value
    && typeof value === 'object'
    && 'error' in value
    && typeof value.error === 'string'
  ) {
    return value.error;
  }
  return 'finance_insight_cutover_request_failed';
}

export async function runFinanceInsightCutoverCli(
  options: FinanceInsightCutoverCliOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = new URL(
    `/api/connectors/${encodeURIComponent(options.connectorId)}/finance-operations`,
    options.origin,
  );
  const headers = new Headers({
    accept: 'application/json',
    'x-mc-api-key': options.apiKey,
  });
  let init: RequestInit;
  if (options.command === 'readiness') {
    url.searchParams.set('sourceGeneration', options.sourceGeneration);
    init = { method: 'GET', headers };
  } else {
    const idempotencyKey = options.idempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new FinanceInsightCutoverCliError(
        'idempotency key is required for enable and rollback',
        2,
      );
    }
    headers.set('content-type', 'application/json');
    headers.set('idempotency-key', idempotencyKey);
    init = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: options.command === 'enable'
          ? 'enable-insight-cutover'
          : 'rollback-insight-cutover',
        sourceGeneration: options.sourceGeneration,
      }),
    };
  }

  const response = await fetchImpl(url, init);
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new FinanceInsightCutoverCliError(responseErrorCode(result));
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new FinanceInsightCutoverCliError('finance_insight_cutover_response_invalid');
  }
  return result;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const result = await runFinanceInsightCutoverCli(
    parseFinanceInsightCutoverCli(args, environment),
    fetchImpl,
  );
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const cliError = error instanceof FinanceInsightCutoverCliError ? error : null;
    console.error(cliError?.message ?? 'finance_insight_cutover_cli_failed');
    process.exitCode = cliError?.exitCode ?? 1;
  });
}
