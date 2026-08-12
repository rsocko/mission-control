import { describe, expect, it, vi } from 'vitest';
import type { CopilotClientOptions, SessionConfig } from '@github/copilot-sdk';
import {
  COPILOT_SMOKE_MAX_AI_CREDITS,
  COPILOT_SMOKE_MARKER,
  loadCopilotSmokeConfig,
  runCopilotSmoke,
  type CopilotSmokeConfig,
} from '@/lib/ai/copilot-runtime-smoke';

const config: CopilotSmokeConfig = {
  authMode: 'token',
  credentialFile: '/run/secrets/copilot_github_token',
  model: 'smoke-model',
  stateDirectory: '/state',
  workingDirectory: '/work',
  startupTimeoutMs: 1_000,
  requestTimeoutMs: 1_000,
  shutdownTimeoutMs: 1_000,
};

function successfulRuntime() {
  const session = {
    sessionId: 'ephemeral-session',
    sendAndWait: vi.fn().mockResolvedValue({
      data: { content: COPILOT_SMOKE_MARKER },
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue([]),
    forceStop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ version: '1.0.75', protocolVersion: 3 }),
    getAuthStatus: vi.fn().mockResolvedValue({
      isAuthenticated: true,
      authType: 'env',
    }),
    listModels: vi.fn().mockResolvedValue([{ id: 'smoke-model' }]),
    createSession: vi.fn().mockResolvedValue(session),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };
  return { client, session };
}

describe('runCopilotSmoke', () => {
  it('uses an isolated empty-mode runtime and deletes its session', async () => {
    const { client, session } = successfulRuntime();
    let clientOptions: CopilotClientOptions | undefined;
    const result = await runCopilotSmoke(config, {
      readCredential: vi.fn().mockResolvedValue('deployment-secret'),
      createClient: (options) => {
        clientOptions = options;
        return client;
      },
    });

    expect(clientOptions).toMatchObject({
      mode: 'empty',
      baseDirectory: '/state',
      workingDirectory: '/work',
      useLoggedInUser: false,
      logLevel: 'none',
      telemetry: { captureContent: false },
    });
    expect(clientOptions?.gitHubToken).toBe('deployment-secret');
    expect(clientOptions?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(clientOptions?.env).toHaveProperty('COPILOT_HOME', '/state');
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining<Partial<SessionConfig>>({
        availableTools: [],
        tools: [],
        enableConfigDiscovery: false,
        skipCustomInstructions: true,
        enableSessionTelemetry: false,
        sessionLimits: { maxAiCredits: COPILOT_SMOKE_MAX_AI_CREDITS },
      }),
    );
    expect(session.sendAndWait).toHaveBeenCalledTimes(1);
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.deleteSession).toHaveBeenCalledWith('ephemeral-session');
    expect(client.stop).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      authMode: 'token',
      authType: 'env',
      cliPackageVersion: '1.0.76-0',
      cliVersion: '1.0.75',
      mode: 'empty',
      availableTools: 0,
      permissionRequests: 0,
      requestCount: 1,
      responseMatched: true,
      shutdown: 'clean',
    });
  });

  it('fails before startup when the deployment secret is missing', async () => {
    const createClient = vi.fn();

    await expect(
      runCopilotSmoke(config, {
        readCredential: vi.fn().mockRejectedValue(new Error('ENOENT')),
        createClient,
      }),
    ).rejects.toMatchObject({ code: 'credential_missing' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('distinguishes unavailable models and still stops the runtime', async () => {
    const { client } = successfulRuntime();
    client.listModels.mockResolvedValue([]);

    await expect(
      runCopilotSmoke(config, {
        readCredential: vi.fn().mockResolvedValue('deployment-secret'),
        createClient: () => client,
      }),
    ).rejects.toMatchObject({ code: 'model_unavailable', phase: 'model' });
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it('classifies an authentication timeout without exposing provider details', async () => {
    const { client } = successfulRuntime();
    client.getAuthStatus.mockReturnValue(new Promise(() => undefined));

    await expect(
      runCopilotSmoke(
        { ...config, startupTimeoutMs: 10 },
        {
          readCredential: vi.fn().mockResolvedValue('deployment-secret'),
          createClient: () => client,
        },
      ),
    ).rejects.toMatchObject({
      code: 'credential_invalid',
      phase: 'authentication',
    });
  });

  it('classifies a model discovery timeout as unavailable', async () => {
    const { client } = successfulRuntime();
    client.listModels.mockReturnValue(new Promise(() => undefined));

    await expect(
      runCopilotSmoke(
        { ...config, startupTimeoutMs: 10 },
        {
          readCredential: vi.fn().mockResolvedValue('deployment-secret'),
          createClient: () => client,
        },
      ),
    ).rejects.toMatchObject({
      code: 'model_unavailable',
      phase: 'model',
    });
  });

  it('accepts an explicit token auth type without desktop fallback', async () => {
    const { client } = successfulRuntime();
    client.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      authType: 'token',
    });

    await expect(
      runCopilotSmoke(config, {
        readCredential: vi.fn().mockResolvedValue('deployment-secret'),
        createClient: () => client,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('uses isolated device credentials without reading a token secret', async () => {
    const { client } = successfulRuntime();
    client.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      authType: 'user',
    });
    const readCredential = vi.fn();
    let clientOptions: CopilotClientOptions | undefined;

    await expect(
      runCopilotSmoke(
        { ...config, authMode: 'device', credentialFile: undefined },
        {
          readCredential,
          createClient: (options) => {
            clientOptions = options;
            return client;
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      authMode: 'device',
      authType: 'user',
    });

    expect(readCredential).not.toHaveBeenCalled();
    expect(clientOptions?.gitHubToken).toBeUndefined();
    expect(clientOptions?.useLoggedInUser).toBe(true);
    expect(clientOptions?.env).toHaveProperty('COPILOT_HOME', '/state');
  });

  it('rejects ambient token auth when device credentials are required', async () => {
    const { client } = successfulRuntime();
    client.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      authType: 'token',
    });

    await expect(
      runCopilotSmoke(
        { ...config, authMode: 'device', credentialFile: undefined },
        {
          readCredential: vi.fn(),
          createClient: () => client,
        },
      ),
    ).rejects.toMatchObject({
      code: 'credential_invalid',
      phase: 'authentication',
    });
  });

  it('accepts the Linux runtime version reported by the pinned package', async () => {
    const { client } = successfulRuntime();
    client.getStatus.mockResolvedValue({ version: '1.0.76-0', protocolVersion: 3 });

    await expect(
      runCopilotSmoke(config, {
        readCredential: vi.fn().mockResolvedValue('deployment-secret'),
        createClient: () => client,
      }),
    ).resolves.toMatchObject({ ok: true, cliVersion: '1.0.76-0' });
  });

  it('rejects runtime versions outside the verified platform values', async () => {
    const { client } = successfulRuntime();
    client.getStatus.mockResolvedValue({ version: '1.0.77', protocolVersion: 3 });

    await expect(
      runCopilotSmoke(config, {
        readCredential: vi.fn().mockResolvedValue('deployment-secret'),
        createClient: () => client,
      }),
    ).rejects.toMatchObject({
      code: 'runtime_startup_failed',
      phase: 'startup',
    });
  });

  describe('loadCopilotSmokeConfig', () => {
    const baseEnvironment: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      COPILOT_SMOKE_MODEL: 'smoke-model',
      COPILOT_SMOKE_STATE_DIR: '/state',
      COPILOT_SMOKE_WORK_DIR: '/work',
    };

    it('keeps token authentication as the default', () => {
      expect(
        loadCopilotSmokeConfig({
          ...baseEnvironment,
          COPILOT_GITHUB_TOKEN_FILE: '/run/secrets/copilot_github_token',
        }),
      ).toMatchObject({
        authMode: 'token',
        credentialFile: '/run/secrets/copilot_github_token',
      });
    });

    it('loads device authentication without a token file', () => {
      expect(
        loadCopilotSmokeConfig({
          ...baseEnvironment,
          COPILOT_SMOKE_AUTH_MODE: 'device',
        }),
      ).toMatchObject({
        authMode: 'device',
        credentialFile: undefined,
      });
    });

    it('rejects unsupported authentication modes', () => {
      expect(() =>
        loadCopilotSmokeConfig({
          ...baseEnvironment,
          COPILOT_SMOKE_AUTH_MODE: 'ambient',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'configuration_invalid',
          phase: 'configuration',
        }),
      );
    });
  });

  it('waits for explicit token authentication to settle after startup', async () => {
    const { client } = successfulRuntime();
    client.getAuthStatus
      .mockResolvedValueOnce({
        isAuthenticated: false,
        statusMessage: 'Not authenticated',
      })
      .mockResolvedValue({
        isAuthenticated: true,
        authType: 'token',
      });

    await expect(
      runCopilotSmoke(config, {
        readCredential: vi.fn().mockResolvedValue('deployment-secret'),
        createClient: () => client,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(client.getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('classifies session creation failures as runtime startup failures', async () => {
    const { client } = successfulRuntime();
    client.createSession.mockRejectedValue(new Error('session initialization failed'));

    await expect(
      runCopilotSmoke(config, {
        readCredential: vi.fn().mockResolvedValue('deployment-secret'),
        createClient: () => client,
      }),
    ).rejects.toMatchObject({
      code: 'runtime_startup_failed',
      phase: 'startup',
    });
  });

  it('aborts the active request and shuts down when signaled', async () => {
    const { client, session } = successfulRuntime();
    const controller = new AbortController();
    session.sendAndWait.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10_000)),
    );

    const run = runCopilotSmoke(
      config,
      {
        readCredential: vi.fn().mockResolvedValue('deployment-secret'),
        createClient: () => client,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(session.sendAndWait).toHaveBeenCalledOnce());
    controller.abort();

    await expect(run).rejects.toMatchObject({
      code: 'interrupted',
      phase: 'request',
    });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it('force stops within the shutdown budget when session cleanup hangs', async () => {
    const { client, session } = successfulRuntime();
    session.disconnect.mockImplementation(() => new Promise(() => undefined));

    await expect(
      runCopilotSmoke(
        { ...config, shutdownTimeoutMs: 100 },
        {
          readCredential: vi.fn().mockResolvedValue('deployment-secret'),
          createClient: () => client,
        },
      ),
    ).rejects.toMatchObject({ code: 'shutdown_failed', phase: 'shutdown' });
    expect(client.forceStop).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it('prioritizes a shutdown failure over a request failure', async () => {
    const { client, session } = successfulRuntime();
    session.sendAndWait.mockRejectedValue(new Error('request transport failed'));
    session.disconnect.mockRejectedValue(new Error('disconnect failed'));

    await expect(
      runCopilotSmoke(config, {
        readCredential: vi.fn().mockResolvedValue('deployment-secret'),
        createClient: () => client,
      }),
    ).rejects.toMatchObject({ code: 'shutdown_failed', phase: 'shutdown' });
    expect(client.forceStop).toHaveBeenCalledOnce();
  });
});
