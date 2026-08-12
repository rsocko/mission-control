import { describe, expect, it } from 'vitest';
import {
  parseGitHubBulkTransferCommand,
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
});
