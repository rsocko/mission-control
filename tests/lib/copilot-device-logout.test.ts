import { describe, expect, it, vi } from 'vitest';
import { logoutCopilotDevice } from '@/lib/ai/copilot-device-logout';

function logoutClient(authInfo: unknown = { type: 'user' }) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue([]),
    forceStop: vi.fn().mockResolvedValue(undefined),
    rpc: {
      account: {
        getCurrentAuth: vi.fn().mockResolvedValue({ authInfo }),
        logout: vi.fn().mockResolvedValue({ hasMoreUsers: false }),
      },
    },
  };
}

describe('logoutCopilotDevice', () => {
  it('logs out the stored user and stops the runtime', async () => {
    const client = logoutClient();

    await expect(
      logoutCopilotDevice('/state', '/work', {
        createClient: () => client,
      }),
    ).resolves.toEqual({
      ok: true,
      hadAuth: true,
      hasMoreUsers: false,
    });

    expect(client.rpc.account.logout).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client.forceStop).not.toHaveBeenCalled();
  });

  it('does not request logout when device state is already empty', async () => {
    const client = logoutClient(null);

    await expect(
      logoutCopilotDevice('/state', '/work', {
        createClient: () => client,
      }),
    ).resolves.toEqual({
      ok: true,
      hadAuth: false,
      hasMoreUsers: false,
    });

    expect(client.rpc.account.logout).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client.forceStop).not.toHaveBeenCalled();
  });

  it('force stops when graceful shutdown exceeds its deadline', async () => {
    const client = logoutClient();
    client.stop.mockImplementation(() => new Promise(() => undefined));

    await expect(
      logoutCopilotDevice(
        '/state',
        '/work',
        {
          createClient: () => client,
        },
        10,
      ),
    ).rejects.toThrow('Copilot device logout shutdown failed');

    expect(client.forceStop).toHaveBeenCalledOnce();
  });
});
