import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSuccessorAuthorization,
  buildTransferScope,
  parseReviewedAllowlist,
  parseGitHubBulkTransferCommand,
  resolveBackupAttestation,
  requireExecutionConfirmation,
  required,
} from '../../scripts/github-bulk-issue-transfer';

describe('GitHub bulk issue transfer CLI', () => {
  it('defaults to non-mutating preview and accepts documented commands', () => {
    expect(parseGitHubBulkTransferCommand(undefined)).toBe('preview');
    expect(parseGitHubBulkTransferCommand('--connector')).toBe('preview');
    expect(parseGitHubBulkTransferCommand('execute')).toBe('execute');
    expect(parseGitHubBulkTransferCommand('resume')).toBe('resume');
    expect(parseGitHubBulkTransferCommand('status')).toBe('status');
    expect(parseGitHubBulkTransferCommand('abort')).toBe('abort');
    expect(parseGitHubBulkTransferCommand('reconcile')).toBe('reconcile');
    expect(() => parseGitHubBulkTransferCommand('force')).toThrow('Unknown command');
  });

  it('parses repository-bound reviewed allowlists and rejects unsafe manifests', () => {
    const raw = JSON.stringify({
      version: 1,
      sourceRepository: 'owner/source',
      issueNodeIds: ['I_1', 'I_2'],
    });

    expect(parseReviewedAllowlist(raw, 'owner/source')).toMatchObject({
      mode: 'reviewed-allowlist',
      sourceRepository: 'owner/source',
      issueNodeIds: ['I_1', 'I_2'],
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(() => parseReviewedAllowlist(raw, 'owner/other'))
      .toThrow('does not match --source');
    expect(() => parseReviewedAllowlist(JSON.stringify({
      version: 1,
      sourceRepository: 'owner/source',
      issueNodeIds: ['I_1', 'I_1'],
    }), 'owner/source')).toThrow('duplicate issue node IDs');
  });

  it('requires an explicit transfer scope and rejects conflicting scope options', () => {
    expect(buildTransferScope({
      allowlistPath: undefined,
      allIssues: true,
      sourceRepository: 'owner/source',
    })).toEqual({ mode: 'all-issues' });
    expect(() => buildTransferScope({
      allowlistPath: undefined,
      allIssues: false,
      sourceRepository: 'owner/source',
    })).toThrow('--allowlist is required');
    expect(() => buildTransferScope({
      allowlistPath: 'reviewed.json',
      allIssues: true,
      sourceRepository: 'owner/source',
    })).toThrow('either --allowlist or --all-issues');
  });

  it('requires exact confirmation and non-empty values', () => {
    expect(() => requireExecutionConfirmation(
      'owner/source=>owner/target',
      'owner/source',
      'owner/target',
    )).not.toThrow();
    expect(() => requireExecutionConfirmation(
      'owner/source=>owner/other',
      'owner/source',
      'owner/target',
    )).toThrow('Execution requires --confirm owner/source=>owner/target');
    expect(required(' operator ', '--actor')).toBe('operator');
    expect(() => required(' ', '--actor')).toThrow('--actor is required');
  });

  it('requires a complete successor authorization when any successor option is present', () => {
    expect(buildSuccessorAuthorization({
      expectedSourceStableIdDigest: undefined,
      expectedSuccessorStableIdDigest: undefined,
      reason: undefined,
      idempotencyKey: undefined,
    })).toBeUndefined();

    expect(buildSuccessorAuthorization({
      expectedSourceStableIdDigest: 'a'.repeat(64),
      expectedSuccessorStableIdDigest: 'b'.repeat(64),
      reason: 'Reviewed native-transfer successor identity',
      idempotencyKey: 'successor-reconcile-836',
    })).toEqual({
      expectedSourceStableIdDigest: 'a'.repeat(64),
      expectedSuccessorStableIdDigest: 'b'.repeat(64),
      reason: 'Reviewed native-transfer successor identity',
      idempotencyKey: 'successor-reconcile-836',
    });

    expect(() => buildSuccessorAuthorization({
      expectedSourceStableIdDigest: 'a'.repeat(64),
      expectedSuccessorStableIdDigest: undefined,
      reason: undefined,
      idempotencyKey: undefined,
    })).toThrow('--successor-node-digest is required');
  });

  it('requires exactly one bounded backup evidence source', async () => {
    await expect(resolveBackupAttestation(undefined, undefined))
      .rejects.toThrow('exactly one');
    await expect(resolveBackupAttestation('backup.db', 'attestation.json'))
      .rejects.toThrow('exactly one');
  });

  it('loads only bounded external backup attestations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mc-backup-attestation-'));
    const attestationPath = join(directory, 'attestation.json');
    const attestation = {
      path: 'approved-backup://mission-control/2026-08-30',
      sha256: 'b'.repeat(64),
      sizeBytes: 4096,
      modifiedAt: '2026-08-30T19:00:00.000Z',
      integrityCheck: 'ok',
      verifiedAt: '2026-08-30T19:05:00.000Z',
      source: 'external-preverified',
    };

    try {
      writeFileSync(attestationPath, JSON.stringify(attestation));
      await expect(resolveBackupAttestation(undefined, attestationPath))
        .resolves.toEqual(attestation);

      writeFileSync(attestationPath, JSON.stringify({ ...attestation, credentials: 'secret' }));
      await expect(resolveBackupAttestation(undefined, attestationPath))
        .rejects.toThrow('unsupported fields');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
