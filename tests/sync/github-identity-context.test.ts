import { describe, expect, it } from 'vitest';
import { freezeGitHubIdentityContext } from '@/lib/sync/github-identity-context';

describe('frozen GitHub identity sync context', () => {
  it('accepts and freezes a queued legacy context', () => {
    expect(freezeGitHubIdentityContext('github-1', {
      connectorInstanceId: 'github-1',
      effectiveMode: 'legacy',
      modeRevision: 7,
    })).toMatchObject({
      phase: null,
      effectiveMode: 'legacy',
      stablePrimaryEnabled: false,
      modeRevision: 7,
    });
  });

  it('accepts and freezes comparison mode without enabling stable-primary', () => {
    const snapshot = freezeGitHubIdentityContext('github-1', {
      connectorInstanceId: 'github-1',
      effectiveMode: 'comparison',
      modeRevision: 7,
    }, '2026-08-03T00:00:00.000Z');

    expect(snapshot).toEqual({
      connectorInstanceId: 'github-1',
      phase: 'comparing',
      effectiveMode: 'comparison',
      stablePrimaryEnabled: false,
      modeRevision: 7,
      capturedAt: '2026-08-03T00:00:00.000Z',
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('reconstructs a frozen stable context after a queued worker restart', () => {
    expect(freezeGitHubIdentityContext('github-1', {
      connectorInstanceId: 'github-1',
      effectiveMode: 'stable',
      modeRevision: 8,
    }, '2026-08-03T00:00:00.000Z')).toEqual({
      connectorInstanceId: 'github-1',
      phase: 'stable_primary',
      effectiveMode: 'stable',
      stablePrimaryEnabled: true,
      modeRevision: 8,
      capturedAt: '2026-08-03T00:00:00.000Z',
    });
  });

  it('rejects a comparison context belonging to another connector', () => {
    expect(() => freezeGitHubIdentityContext('github-1', {
      connectorInstanceId: 'github-2',
      effectiveMode: 'comparison',
      modeRevision: 7,
    })).toThrow('Frozen GitHub identity context belongs to another connector');
  });
});
