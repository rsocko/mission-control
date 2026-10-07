import { beforeEach, describe, expect, it, vi } from 'vitest';

const { discoverPaperclip } = vi.hoisted(() => ({
  discoverPaperclip: vi.fn(),
}));

vi.mock('@/lib/external-agents/paperclip', () => ({
  discoverPaperclip,
}));

import {
  completePaperclipAuthorization,
  consumePaperclipAuthorization,
  pollPaperclipAuthorization,
  startPaperclipAuthorization,
} from '@/lib/connectors/paperclip/auth-session';

describe('Paperclip connector authorization', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    discoverPaperclip.mockReset();
    discoverPaperclip.mockResolvedValue({
      companies: [{ id: 'company-1', name: 'Research', status: 'active' }],
      projects: [],
      agents: [],
    });
  });

  it('exchanges a browser-approved temporary key for a named 90-day connector key', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.pathname === '/api/cli-auth/challenges') {
        return Response.json({
          id: 'challenge-1',
          token: 'challenge-token',
          boardApiToken: 'temporary-board-token',
          approvalPath: '/cli-auth/challenge-1',
          approvalUrl: null,
          pollPath: '/cli-auth/challenges/challenge-1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          suggestedPollIntervalMs: 100,
        });
      }
      if (url.pathname === '/api/cli-auth/challenges/challenge-1') {
        expect(url.searchParams.get('token')).toBe('challenge-token');
        return Response.json({ status: 'approved' });
      }
      if (url.pathname === '/api/cli-auth/me') {
        expect(authorization).toBe('Bearer temporary-board-token');
        return Response.json({
          userId: 'user-1',
          user: { id: 'user-1', name: 'Operator' },
          keyId: 'temporary-key-1',
        });
      }
      if (url.pathname === '/api/board-api-keys') {
        expect(authorization).toBe('Bearer temporary-board-token');
        const body = JSON.parse(String(init?.body)) as {
          name: string;
          expiresAt: string;
        };
        expect(body.name).toBe('mission-control-connector');
        expect(Date.parse(body.expiresAt) - Date.now())
          .toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
        return Response.json({
          id: 'connector-key-1',
          token: 'connector-board-token',
          expiresAt: body.expiresAt,
        });
      }
      if (url.pathname === '/api/cli-auth/revoke-current') {
        expect(authorization).toBe('Bearer temporary-board-token');
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected Paperclip request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const started = await startPaperclipAuthorization('https://paperclip.example.test');
    expect(started).toMatchObject({
      approvalUrl: 'https://paperclip.example.test/cli-auth/challenge-1',
      suggestedPollIntervalMs: 500,
    });
    const approved = await pollPaperclipAuthorization(started.authSessionId);
    expect(approved).toMatchObject({
      status: 'approved',
      keyId: 'connector-key-1',
      userId: 'user-1',
      companies: [{ id: 'company-1', name: 'Research' }],
    });
    expect(JSON.stringify(approved)).not.toContain('connector-board-token');

    expect(consumePaperclipAuthorization(
      started.authSessionId,
      'https://paperclip.example.test',
      'company-1',
    )).toMatchObject({
      apiToken: 'connector-board-token',
      companyName: 'Research',
      keyId: 'connector-key-1',
      boardUserId: 'user-1',
      boardUserName: 'Operator',
    });
    expect(consumePaperclipAuthorization(
      started.authSessionId,
      'https://paperclip.example.test',
      'company-1',
    )).toMatchObject({ apiToken: 'connector-board-token' });
    completePaperclipAuthorization(started.authSessionId);
    expect(() => consumePaperclipAuthorization(
      started.authSessionId,
      'https://paperclip.example.test',
      'company-1',
    )).toThrow('session was not found');
  });
});
