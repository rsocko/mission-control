#!/usr/bin/env tsx

import process from 'node:process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  abortGitHubBulkTransfer,
  executeGitHubBulkTransfer,
  getGitHubBulkTransferStatus,
  previewGitHubBulkTransfer,
  reconcileGitHubBulkTransferItem,
  type GitHubBulkTransferSuccessorAuthorization,
  type GitHubBulkTransferScope,
} from '../src/lib/connectors/github-issues/bulk-transfer-service';
import { inspectGitHubRepointBackup } from '../src/lib/connectors/github-issues/repoint-service';

export type GitHubBulkTransferCommand =
  | 'preview' | 'execute' | 'status' | 'resume' | 'abort' | 'reconcile';

async function main(): Promise<void> {
  const command = parseGitHubBulkTransferCommand(process.argv[2]);
  const optionStart = process.argv[2]?.startsWith('--') ? 2 : 3;
  const { values } = parseArgs({
    args: process.argv.slice(optionStart),
    options: {
      connector: { type: 'string' },
      source: { type: 'string' },
      target: { type: 'string' },
      backup: { type: 'string' },
      actor: { type: 'string' },
      allowlist: { type: 'string' },
      'all-issues': { type: 'boolean' },
      run: { type: 'string' },
      'plan-hash': { type: 'string' },
      'idempotency-key': { type: 'string' },
      concurrency: { type: 'string' },
      task: { type: 'string' },
      'target-number': { type: 'string' },
      'source-node-digest': { type: 'string' },
      'successor-node-digest': { type: 'string' },
      'successor-reason': { type: 'string' },
      'successor-key': { type: 'string' },
      confirm: { type: 'string' },
    },
    strict: true,
  });

  if (command === 'status') {
    print(getGitHubBulkTransferStatus(required(values.run, '--run')));
    return;
  }
  if (command === 'abort') {
    if (values.confirm !== 'abort') throw new Error('Abort requires --confirm abort');
    print(abortGitHubBulkTransfer(
      required(values.run, '--run'),
      required(values.actor, '--actor'),
    ));
    return;
  }
  if (command === 'reconcile') {
    if (values.confirm !== 'reconcile') {
      throw new Error('Reconciliation requires --confirm reconcile');
    }
    print(await reconcileGitHubBulkTransferItem({
      runId: required(values.run, '--run'),
      taskId: required(values.task, '--task'),
      targetNumber: positiveInteger(values['target-number'], '--target-number'),
      actor: required(values.actor, '--actor'),
      successorAuthorization: buildSuccessorAuthorization({
        expectedSourceStableIdDigest: values['source-node-digest'],
        expectedSuccessorStableIdDigest: values['successor-node-digest'],
        reason: values['successor-reason'],
        idempotencyKey: values['successor-key'],
      }),
    }));
    return;
  }

  const sourceRepository = required(values.source, '--source');
  const targetRepository = required(values.target, '--target');
  const scope = buildTransferScope({
    allowlistPath: values.allowlist,
    allIssues: values['all-issues'] ?? false,
    sourceRepository,
  });
  const common = {
    connectorInstanceId: required(values.connector, '--connector'),
    sourceRepository,
    targetRepository,
    actor: required(values.actor, '--actor'),
    backupProof: await inspectGitHubRepointBackup(required(values.backup, '--backup')),
    scope,
  };
  if (command === 'preview') {
    const result = await previewGitHubBulkTransfer(common);
    print(result);
    if (!result.go) process.exitCode = 2;
    return;
  }
  requireExecutionConfirmation(values.confirm, sourceRepository, targetRepository);
  print(await executeGitHubBulkTransfer({
    ...common,
    idempotencyKey: required(values['idempotency-key'], '--idempotency-key'),
    planHash: required(values['plan-hash'], '--plan-hash'),
    confirmation: values.confirm!,
    concurrency: optionalConcurrency(values.concurrency),
  }));
}

export function parseGitHubBulkTransferCommand(
  value: string | undefined,
): GitHubBulkTransferCommand {
  if (!value || value.startsWith('--')) return 'preview';
  if (['preview', 'execute', 'status', 'resume', 'abort', 'reconcile'].includes(value)) {
    return value as GitHubBulkTransferCommand;
  }
  throw new Error(`Unknown command: ${value}`);
}

export function requireExecutionConfirmation(
  actual: string | undefined,
  source: string,
  target: string,
): void {
  const expected = `${source}=>${target}`;
  if (actual !== expected) throw new Error(`Execution requires --confirm ${expected}`);
}

export function required(value: string | undefined, option: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${option} is required`);
  return normalized;
}

export function buildSuccessorAuthorization(input: {
  expectedSourceStableIdDigest: string | undefined;
  expectedSuccessorStableIdDigest: string | undefined;
  reason: string | undefined;
  idempotencyKey: string | undefined;
}): GitHubBulkTransferSuccessorAuthorization | undefined {
  if (Object.values(input).every((value) => value === undefined)) return undefined;
  return {
    expectedSourceStableIdDigest: required(
      input.expectedSourceStableIdDigest,
      '--source-node-digest',
    ),
    expectedSuccessorStableIdDigest: required(
      input.expectedSuccessorStableIdDigest,
      '--successor-node-digest',
    ),
    reason: required(input.reason, '--successor-reason'),
    idempotencyKey: required(input.idempotencyKey, '--successor-key'),
  };
}

export function buildTransferScope(input: {
  allowlistPath: string | undefined;
  allIssues: boolean;
  sourceRepository: string;
}): GitHubBulkTransferScope {
  if (input.allowlistPath && input.allIssues) {
    throw new Error('Use either --allowlist or --all-issues, not both');
  }
  if (input.allIssues) return { mode: 'all-issues' };
  const allowlistPath = required(input.allowlistPath, '--allowlist');
  const raw = readFileSync(allowlistPath, 'utf8');
  return parseReviewedAllowlist(raw, input.sourceRepository);
}

export function parseReviewedAllowlist(
  raw: string,
  requestedSourceRepository: string,
): GitHubBulkTransferScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Allowlist must be valid JSON');
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).version !== 1
    || typeof (parsed as Record<string, unknown>).sourceRepository !== 'string'
    || !Array.isArray((parsed as Record<string, unknown>).issueNodeIds)
  ) {
    throw new Error('Allowlist must contain version, sourceRepository, and issueNodeIds');
  }
  const manifest = parsed as {
    version: 1;
    sourceRepository: string;
    issueNodeIds: unknown[];
  };
  if (manifest.sourceRepository.toLowerCase() !== requestedSourceRepository.toLowerCase()) {
    throw new Error('Allowlist sourceRepository does not match --source');
  }
  if (
    manifest.issueNodeIds.length === 0
    || manifest.issueNodeIds.some((nodeId) => typeof nodeId !== 'string')
  ) {
    throw new Error('Allowlist issueNodeIds must be a non-empty string array');
  }
  const issueNodeIds = manifest.issueNodeIds as string[];
  if (new Set(issueNodeIds).size !== issueNodeIds.length) {
    throw new Error('Allowlist contains duplicate issue node IDs');
  }
  return {
    mode: 'reviewed-allowlist',
    sourceRepository: manifest.sourceRepository,
    manifestSha256: createHash('sha256').update(raw).digest('hex'),
    issueNodeIds,
  };
}

function optionalConcurrency(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('--concurrency must be an integer');
  return parsed;
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(required(value, option));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
