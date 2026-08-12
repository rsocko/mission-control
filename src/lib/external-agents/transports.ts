import 'server-only';

import { createHmac } from 'node:crypto';
import type {
  AgentDispatchResult,
  AgentDispatchStatus,
  ExternalAgentTransport,
} from '@/db/schema';
import type { ExternalAgent } from './registry';
import { resolveAgentCredential } from './registry';
import { canonicalJson, redactForPersistence } from './policy';
import { ExternalAgentError } from './errors';

export interface TransportDispatch {
  dispatchId: string;
  attempt: number;
  payload: Record<string, unknown>;
}

export interface TransportDispatchResult {
  status: Extract<
    AgentDispatchStatus,
    'queued' | 'in_progress' | 'waiting_for_user' | 'completed' | 'failed'
  >;
  providerTaskId?: string;
  providerState?: string;
  providerDetail?: Record<string, unknown>;
  result?: AgentDispatchResult;
  errorMessage?: string;
  manualUrl?: string;
}

export interface ExternalAgentTransportAdapter {
  readonly kind: ExternalAgentTransport;
  dispatch(agent: ExternalAgent, dispatch: TransportDispatch): Promise<TransportDispatchResult>;
  cancel?(
    agent: ExternalAgent,
    providerTaskId: string | null,
  ): Promise<{ providerState?: string; providerDetail?: Record<string, unknown> }>;
}

export interface McpAgentInvoker {
  invoke(
    endpoint: string,
    payload: Record<string, unknown>,
    options: { credential: string | null; dispatchId: string; attempt: number },
  ): Promise<TransportDispatchResult>;
}

async function readBoundedResponse(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ExternalAgentError(
      'External-agent response exceeded the size limit',
      'PAYLOAD_TOO_LARGE',
      502,
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ExternalAgentError(
        'External-agent response exceeded the size limit',
        'PAYLOAD_TOO_LARGE',
        502,
      );
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export type TransportResolver = (agent: ExternalAgent) => ExternalAgentTransportAdapter;

function providerStatus(value: unknown): TransportDispatchResult['status'] {
  switch (value) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'running':
    case 'in_progress':
    case 'idle':
      return 'in_progress';
    case 'waiting':
    case 'waiting_for_user':
    case 'needs_confirmation':
      return 'waiting_for_user';
    case 'completed':
    case 'succeeded':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
    case 'cancelled':
      return 'failed';
    default:
      return 'in_progress';
  }
}

function assertImplementedAgent(agent: ExternalAgent) {
  if (agent.type === 'copilot-cloud') {
    throw new ExternalAgentError(
      'GitHub-hosted Copilot dispatch is reserved for issue #931 and is not configured',
      'TRANSPORT_NOT_IMPLEMENTED',
      501,
    );
  }
  if (agent.type === 'copilot-sdk-workspace') {
    throw new ExternalAgentError(
      'Mission Control-hosted Copilot workspace execution is reserved for issue #2123',
      'TRANSPORT_NOT_IMPLEMENTED',
      501,
    );
  }
}

function authenticatedHeaders(agent: ExternalAgent, body: string) {
  const credential = resolveAgentCredential(agent.authCredentialRef);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (agent.authType === 'bearer' || agent.authType === 'github-user') {
    headers.Authorization = `Bearer ${credential}`;
  } else if (agent.authType === 'hmac') {
    if (!credential) {
      throw new ExternalAgentError(
        'HMAC agent credential is unavailable',
        'CREDENTIAL_UNAVAILABLE',
        503,
      );
    }
    headers['X-MC-Signature'] = `sha256=${createHmac('sha256', credential).update(body).digest('hex')}`;
  }
  return headers;
}

export function createPushTransport(fetcher: typeof fetch = fetch): ExternalAgentTransportAdapter {
  return {
    kind: 'push',
    async dispatch(agent, dispatch) {
      assertImplementedAgent(agent);
      if (!agent.endpoint) {
        throw new ExternalAgentError('Push agent endpoint is missing', 'TRANSPORT_INVALID', 500);
      }
      const body = canonicalJson(dispatch.payload);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let response: Response;
      let responseText: string;
      try {
        response = await fetcher(agent.endpoint, {
          method: 'POST',
          headers: {
            ...authenticatedHeaders(agent, body),
            'Idempotency-Key': `${dispatch.dispatchId}:${dispatch.attempt}`,
            'X-MC-Dispatch-Id': dispatch.dispatchId,
          },
          body,
          signal: controller.signal,
        });
        responseText = await readBoundedResponse(response, 512 * 1024);
      } catch (error) {
        if (error instanceof ExternalAgentError) throw error;
        throw new ExternalAgentError(
          error instanceof Error && error.name === 'AbortError'
            ? 'External-agent dispatch timed out'
            : 'External-agent dispatch failed',
          'TRANSPORT_ERROR',
          502,
        );
      } finally {
        clearTimeout(timeout);
      }
      let responseBody: Record<string, unknown> = {};
      if (responseText) {
        try {
          const parsed = JSON.parse(responseText);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            responseBody = parsed as Record<string, unknown>;
          }
        } catch {
          responseBody = { message: responseText };
        }
      }
      const safeDetail = redactForPersistence(responseBody) as Record<string, unknown>;
      if (!response.ok) {
        return {
          status: 'failed',
          providerState: String(responseBody.status ?? `http_${response.status}`),
          providerDetail: safeDetail,
          errorMessage: `External agent returned HTTP ${response.status}`,
        };
      }
      return {
        status: providerStatus(responseBody.status),
        providerState: typeof responseBody.status === 'string' ? responseBody.status : undefined,
        providerTaskId: typeof responseBody.taskId === 'string'
          ? responseBody.taskId
          : typeof responseBody.id === 'string'
            ? responseBody.id
            : undefined,
        providerDetail: safeDetail,
        result: responseBody.result && typeof responseBody.result === 'object'
          ? responseBody.result as AgentDispatchResult
          : undefined,
      };
    },
  };
}

export function createPullTransport(): ExternalAgentTransportAdapter {
  return {
    kind: 'pull',
    async dispatch(agent) {
      assertImplementedAgent(agent);
      return { status: 'queued', providerState: 'awaiting_claim' };
    },
  };
}

export function createManualTransport(): ExternalAgentTransportAdapter {
  return {
    kind: 'manual',
    async dispatch(agent) {
      return {
        status: 'waiting_for_user',
        providerState: 'manual_handoff',
        manualUrl: agent.endpoint ?? undefined,
      };
    },
  };
}

export function createMcpTransport(invoker?: McpAgentInvoker): ExternalAgentTransportAdapter {
  return {
    kind: 'mcp',
    async dispatch(agent, dispatch) {
      if (!invoker) {
        throw new ExternalAgentError(
          'No MCP client is configured; transport execution remains isolated behind its interface',
          'TRANSPORT_UNAVAILABLE',
          503,
        );
      }
      if (!agent.endpoint) {
        throw new ExternalAgentError('MCP agent endpoint is missing', 'TRANSPORT_INVALID', 500);
      }
      return invoker.invoke(agent.endpoint, dispatch.payload, {
        credential: resolveAgentCredential(agent.authCredentialRef),
        dispatchId: dispatch.dispatchId,
        attempt: dispatch.attempt,
      });
    },
  };
}

export function createTransportResolver(options: {
  fetcher?: typeof fetch;
  mcpInvoker?: McpAgentInvoker;
} = {}): TransportResolver {
  const adapters: Record<ExternalAgentTransport, ExternalAgentTransportAdapter> = {
    push: createPushTransport(options.fetcher),
    pull: createPullTransport(),
    manual: createManualTransport(),
    mcp: createMcpTransport(options.mcpInvoker),
  };
  return (agent) => adapters[agent.transport];
}
