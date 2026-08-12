import {
  CopilotClient,
  type CopilotClientOptions,
  type GetAuthStatusResponse,
  type GetStatusResponse,
  type ModelInfo,
  type PermissionHandler,
  type SessionConfig,
} from '@github/copilot-sdk';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  classifyCopilotSmokeError,
  CopilotSmokeError,
  type CopilotSmokePhase,
} from './copilot-runtime-errors';

export const COPILOT_SDK_VERSION = '1.0.8';
export const COPILOT_CLI_PACKAGE_VERSION = '1.0.76-0';
export const COPILOT_CLI_RUNTIME_VERSIONS: readonly string[] = ['1.0.75', '1.0.76-0'];
export const COPILOT_SDK_PROTOCOL_VERSION = 3;
export const COPILOT_SMOKE_MARKER = 'MC_COPILOT_SMOKE_OK';
export const COPILOT_SMOKE_MAX_AI_CREDITS = 30;
export type CopilotSmokeAuthMode = 'token' | 'device';

export function createIsolatedCopilotSessionConfig(
  clientName: string,
  model: string,
  onPermissionRequest: PermissionHandler,
): SessionConfig {
  return {
    clientName,
    model,
    availableTools: [],
    tools: [],
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    requestCanvasRenderer: false,
    requestExtensions: false,
    enableSessionTelemetry: false,
    enableSessionStore: false,
    enableSkills: false,
    remoteSession: 'off',
    mcpOAuthTokenStorage: 'in-memory',
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory',
    infiniteSessions: { enabled: false },
    sessionLimits: { maxAiCredits: COPILOT_SMOKE_MAX_AI_CREDITS },
    onPermissionRequest,
  };
}

export interface CopilotSmokeConfig {
  authMode: CopilotSmokeAuthMode;
  credentialFile?: string;
  model: string;
  stateDirectory: string;
  workingDirectory: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

interface SmokeSession {
  readonly sessionId: string;
  sendAndWait(prompt: string, timeout?: number): Promise<
    | {
        data: { content: string };
      }
    | undefined
  >;
  disconnect(): Promise<void>;
  abort(): Promise<void>;
}

interface SmokeClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  getStatus(): Promise<GetStatusResponse>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  listModels(): Promise<ModelInfo[]>;
  createSession(config: SessionConfig): Promise<SmokeSession>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface CopilotSmokeResult {
  ok: true;
  authMode: CopilotSmokeAuthMode;
  authType: NonNullable<GetAuthStatusResponse['authType']> | 'unknown';
  sdkVersion: string;
  cliPackageVersion: string;
  cliVersion: string;
  protocolVersion: number;
  model: string;
  mode: 'empty';
  availableTools: 0;
  permissionRequests: 0;
  requestCount: 1;
  responseMatched: true;
  shutdown: 'clean';
}

interface SmokeDependencies {
  createClient(options: CopilotClientOptions): SmokeClient;
  readCredential(filePath: string): Promise<string>;
}

const defaultDependencies: SmokeDependencies = {
  createClient: (options) => new CopilotClient(options) as SmokeClient,
  readCredential: (filePath) => readFile(filePath, 'utf8'),
};

function parseDuration(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new CopilotSmokeError('configuration_invalid', 'configuration');
  }
  return parsed;
}

function requireAbsolutePath(value: string | undefined): string {
  if (!value || !path.isAbsolute(value)) {
    throw new CopilotSmokeError('configuration_invalid', 'configuration');
  }
  return value;
}

export function loadCopilotSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
): CopilotSmokeConfig {
  if (!env.COPILOT_SMOKE_MODEL?.trim()) {
    throw new CopilotSmokeError('configuration_invalid', 'configuration');
  }
  const authMode = env.COPILOT_SMOKE_AUTH_MODE?.trim() || 'token';
  if (authMode !== 'token' && authMode !== 'device') {
    throw new CopilotSmokeError('configuration_invalid', 'configuration');
  }

  return {
    authMode,
    credentialFile:
      authMode === 'token'
        ? requireAbsolutePath(env.COPILOT_GITHUB_TOKEN_FILE)
        : undefined,
    model: env.COPILOT_SMOKE_MODEL.trim(),
    stateDirectory: requireAbsolutePath(env.COPILOT_SMOKE_STATE_DIR),
    workingDirectory: requireAbsolutePath(env.COPILOT_SMOKE_WORK_DIR),
    startupTimeoutMs: parseDuration(env.COPILOT_SMOKE_STARTUP_TIMEOUT_MS, 20_000),
    requestTimeoutMs: parseDuration(env.COPILOT_SMOKE_REQUEST_TIMEOUT_MS, 30_000),
    shutdownTimeoutMs: parseDuration(env.COPILOT_SMOKE_SHUTDOWN_TIMEOUT_MS, 10_000),
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  phase: CopilotSmokePhase,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const failureCode =
    phase === 'shutdown'
        ? 'shutdown_failed'
        : phase === 'request'
          ? 'request_failed'
          : phase === 'authentication'
            ? 'credential_invalid'
            : phase === 'entitlement'
              ? 'entitlement_denied'
              : phase === 'model'
                ? 'model_unavailable'
                : 'runtime_startup_failed';
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CopilotSmokeError(failureCode, phase)),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CopilotSmokeError('interrupted', phase));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function runtimeEnvironment(config: CopilotSmokeConfig): Record<string, string> {
  const env: Record<string, string> = {
    COPILOT_HOME: config.stateDirectory,
    HOME: config.stateDirectory,
    TMPDIR: process.env.TMPDIR ?? config.stateDirectory,
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

function remainingMs(deadline: number, phase: CopilotSmokePhase): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new CopilotSmokeError(
      phase === 'startup' ? 'runtime_startup_failed' : 'shutdown_failed',
      phase,
    );
  }
  return remaining;
}

async function waitForAuthentication(
  client: SmokeClient,
  authMode: CopilotSmokeAuthMode,
  startupDeadline: number,
  signal?: AbortSignal,
): Promise<GetAuthStatusResponse> {
  const authDeadline = Math.min(startupDeadline, Date.now() + 5_000);
  let auth: GetAuthStatusResponse | undefined;

  while (Date.now() < authDeadline) {
    auth = await withTimeout(
      client.getAuthStatus(),
      remainingMs(authDeadline, 'startup'),
      'authentication',
      signal,
    );
    const expectedAuthType =
      authMode === 'device'
        ? auth.authType === 'user'
        : auth.authType !== 'user' && auth.authType !== 'gh-cli';
    if (auth.isAuthenticated && expectedAuthType) {
      return auth;
    }
    if (
      auth.isAuthenticated ||
      auth.authType === 'user' ||
      auth.authType === 'gh-cli'
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw classifyCopilotSmokeError(
    new Error(auth?.statusMessage ?? 'Authentication failed'),
    'authentication',
  );
}

export async function runCopilotSmoke(
  config: CopilotSmokeConfig,
  dependencies: SmokeDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<CopilotSmokeResult> {
  let credential: string | undefined;
  if (config.authMode === 'token') {
    if (!config.credentialFile) {
      throw new CopilotSmokeError('configuration_invalid', 'configuration');
    }
    try {
      credential = (await dependencies.readCredential(config.credentialFile)).trim();
    } catch {
      throw new CopilotSmokeError('credential_missing', 'configuration');
    }
    if (!credential) {
      throw new CopilotSmokeError('credential_missing', 'configuration');
    }
  }

  const client = dependencies.createClient({
    mode: 'empty',
    baseDirectory: config.stateDirectory,
    workingDirectory: config.workingDirectory,
    ...(credential ? { gitHubToken: credential } : {}),
    useLoggedInUser: config.authMode === 'device',
    logLevel: 'none',
    env: runtimeEnvironment(config),
    telemetry: {
      captureContent: false,
    },
  });
  credential = undefined;

  let session: SmokeSession | undefined;
  let operationError: unknown;
  let phase: CopilotSmokePhase = 'startup';
  let result: CopilotSmokeResult | undefined;
  let permissionRequests = 0;

  try {
    const startupDeadline = Date.now() + config.startupTimeoutMs;
    await withTimeout(
      client.start(),
      remainingMs(startupDeadline, 'startup'),
      'startup',
      signal,
    );

    const status = await withTimeout(
      client.getStatus(),
      remainingMs(startupDeadline, 'startup'),
      'startup',
      signal,
    );
    if (
      !COPILOT_CLI_RUNTIME_VERSIONS.includes(status.version) ||
      status.protocolVersion !== COPILOT_SDK_PROTOCOL_VERSION
    ) {
      throw new CopilotSmokeError('runtime_startup_failed', 'startup');
    }

    phase = 'authentication';
    const auth = await waitForAuthentication(
      client,
      config.authMode,
      startupDeadline,
      signal,
    );

    phase = 'model';
    const models = await withTimeout(
      client.listModels(),
      remainingMs(startupDeadline, 'startup'),
      'model',
      signal,
    );
    if (!models.some((model) => model.id === config.model)) {
      throw new CopilotSmokeError('model_unavailable', phase);
    }

    phase = 'startup';
    session = await withTimeout(
      client.createSession(
        createIsolatedCopilotSessionConfig(
          'mission-control-copilot-runtime-smoke',
          config.model,
          () => {
          permissionRequests += 1;
          return { kind: 'reject', feedback: 'The smoke runtime denies all permissions.' };
          },
        ),
      ),
      remainingMs(startupDeadline, 'startup'),
      'startup',
      signal,
    );

    phase = 'request';
    const response = await withTimeout(
      session.sendAndWait(
        `Reply with exactly ${COPILOT_SMOKE_MARKER} and nothing else.`,
        config.requestTimeoutMs,
      ),
      config.requestTimeoutMs + 1_000,
      'request',
      signal,
    );
    if (response?.data.content.trim() !== COPILOT_SMOKE_MARKER || permissionRequests !== 0) {
      throw new CopilotSmokeError('request_failed', phase);
    }

    result = {
      ok: true,
      authMode: config.authMode,
      authType: auth.authType ?? 'unknown',
      sdkVersion: COPILOT_SDK_VERSION,
      cliPackageVersion: COPILOT_CLI_PACKAGE_VERSION,
      cliVersion: status.version,
      protocolVersion: status.protocolVersion,
      model: config.model,
      mode: 'empty',
      availableTools: 0,
      permissionRequests,
      requestCount: 1,
      responseMatched: true,
      shutdown: 'clean',
    };
  } catch (error) {
    operationError = classifyCopilotSmokeError(error, phase);
  }

  const shutdownErrors: unknown[] = [];
  const shutdownDeadline = Date.now() + config.shutdownTimeoutMs;
  const gracefulShutdownDeadline =
    shutdownDeadline - Math.max(250, Math.floor(config.shutdownTimeoutMs * 0.2));
  let forceStop = false;
  if (session) {
    try {
      await withTimeout(
        (async () => {
          if (operationError && (phase === 'request' || signal?.aborted)) {
            await session.abort();
          }
          await session.disconnect();
          await client.deleteSession(session.sessionId);
        })(),
        remainingMs(gracefulShutdownDeadline, 'shutdown'),
        'shutdown',
      );
    } catch (error) {
      shutdownErrors.push(error);
      forceStop = true;
    }
  }
  if (!forceStop) {
    try {
      const stopErrors = await withTimeout(
        client.stop(),
        remainingMs(gracefulShutdownDeadline, 'shutdown'),
        'shutdown',
      );
      shutdownErrors.push(...stopErrors);
      forceStop = stopErrors.length > 0;
    } catch (error) {
      shutdownErrors.push(error);
      forceStop = true;
    }
  }
  if (forceStop) {
    try {
      await withTimeout(
        client.forceStop(),
        remainingMs(shutdownDeadline, 'shutdown'),
        'shutdown',
      );
    } catch (error) {
      shutdownErrors.push(error);
    }
  }

  if (shutdownErrors.length > 0) {
    throw new CopilotSmokeError('shutdown_failed', 'shutdown');
  }
  if (operationError) throw operationError;
  if (!result) {
    throw new CopilotSmokeError('request_failed', 'request');
  }
  return result;
}
