import { describe, expect, it } from 'vitest';
import { freezeGitHubIdentityContext } from '@/lib/sync/github-identity-context';

describe('frozen GitHub identity sync context', () => {
  it('freezes the permanent NodeID identity epoch for a queued job', () => {
    const snapshot = freezeGitHubIdentityContext('github-1', {
      connectorInstanceId: 'github-1',
      modeRevision: 7,
    }, '2026-08-03T00:00:00.000Z');

    expect(snapshot).toEqual({
      connectorInstanceId: 'github-1',
      effectiveMode: 'stable',
      modeRevision: 7,
      capturedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('reconstructs the frozen context after a queued worker restart', () => {
    expect(freezeGitHubIdentityContext('github-1', {
      connectorInstanceId: 'github-1',
      modeRevision: 8,
    }, '2026-08-03T00:00:00.000Z')).toEqual({
      connectorInstanceId: 'github-1',
      effectiveMode: 'stable',
      modeRevision: 8,
      capturedAt: '2026-08-03T00:00:00.000Z',
    });
  });

  it('rejects a context belonging to another connector', () => {
    expect(() => freezeGitHubIdentityContext('github-1', {
      connectorInstanceId: 'github-2',
      modeRevision: 7,
    })).toThrow('Frozen GitHub identity context belongs to another connector');
  });
});
