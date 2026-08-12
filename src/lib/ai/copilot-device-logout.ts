import { CopilotClient, type CopilotClientOptions } from '@github/copilot-sdk';

interface DeviceLogoutClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  rpc: {
    account: {
      getCurrentAuth(): Promise<{ authInfo?: unknown }>;
      logout(input: { authInfo: unknown }): Promise<{ hasMoreUsers: boolean }>;
    };
  };
}

interface DeviceLogoutDependencies {
  createClient(options: CopilotClientOptions): DeviceLogoutClient;
}

export interface CopilotDeviceLogoutResult {
  ok: true;
  hadAuth: boolean;
  hasMoreUsers: boolean;
}

const defaultDependencies: DeviceLogoutDependencies = {
  createClient: (options) => new CopilotClient(options) as DeviceLogoutClient,
};

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Copilot device logout timed out')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logoutEnvironment(stateDirectory: string): Record<string, string> {
  const env: Record<string, string> = {
    COPILOT_HOME: stateDirectory,
    HOME: stateDirectory,
    TMPDIR: process.env.TMPDIR ?? stateDirectory,
  };
  for (const key of [
    'PATH',
    'LANG',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export async function logoutCopilotDevice(
  stateDirectory: string,
  workingDirectory: string,
  dependencies: DeviceLogoutDependencies = defaultDependencies,
  shutdownTimeoutMs = 10_000,
): Promise<CopilotDeviceLogoutResult> {
  const client = dependencies.createClient({
    mode: 'empty',
    baseDirectory: stateDirectory,
    workingDirectory,
    env: logoutEnvironment(stateDirectory),
    useLoggedInUser: true,
    logLevel: 'none',
    telemetry: { captureContent: false },
  });

  try {
    await client.start();
    const current = await client.rpc.account.getCurrentAuth();
    if (!current.authInfo) {
      return { ok: true, hadAuth: false, hasMoreUsers: false };
    }
    const result = await client.rpc.account.logout({ authInfo: current.authInfo });
    return { ok: true, hadAuth: true, hasMoreUsers: result.hasMoreUsers };
  } finally {
    let stoppedCleanly = false;
    try {
      const errors = await withTimeout(client.stop(), shutdownTimeoutMs);
      stoppedCleanly = errors.length === 0;
    } catch {
      // Force-stop below.
    }
    if (!stoppedCleanly) {
      await withTimeout(client.forceStop(), shutdownTimeoutMs).catch(() => undefined);
      throw new Error('Copilot device logout shutdown failed');
    }
  }
}
