import { describe, expect, it, vi } from 'vitest';
import {
  CompanionActionHttpError,
  createCompanionActionClient,
} from '@/lib/connectors/rymessage/companion-action-client';

const NOW = '2026-01-02T03:04:05.000Z';
const FEED_ID = '10000000-0000-4000-8000-000000000001';
const ACTION_ID = '10000000-0000-5000-8000-000000000002';

function terminalPage() {
  return {
    schemaVersion: '2.0',
    feedId: FEED_ID,
    mode: 'full',
    producedAt: NOW,
    nextCursor: 'incremental:terminal',
    complete: true,
    items: [{
      eventId: '10000000-0000-4000-8000-000000000003',
      operationId: '10000000-0000-4000-8000-000000000004',
      aggregateId: ACTION_ID,
      aggregateVersion: 1,
      sourceId: `rymessage:${FEED_ID}:action:${ACTION_ID}`,
      occurredAt: NOW,
      kind: 'tombstone',
    }],
  };
}

describe('Companion canonical ActionV2 client', () => {
  it('requests physical pages of 20 and preserves a terminal incremental cursor', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(terminalPage()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = createCompanionActionClient({
      baseUrl: 'https://companion.example',
      credential: 'credential',
      trustedMissionControlOrigin: 'https://mission-control.example',
      fetchImpl,
      maxRetries: 0,
    });

    await expect(client.fetchPageV2(null)).resolves.toMatchObject({
      complete: true,
      nextCursor: 'incremental:terminal',
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://companion.example/v2/integrations/action-feed?limit=20',
    );
  });

  it('surfaces cursor expiry for the connector to restart cursorlessly', async () => {
    const client = createCompanionActionClient({
      baseUrl: 'https://companion.example',
      credential: 'credential',
      trustedMissionControlOrigin: 'https://mission-control.example',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: { code: 'cursor_expired' },
      }), { status: 410 })),
      maxRetries: 0,
    });

    await expect(client.fetchPageV2('expired')).rejects.toEqual(
      expect.objectContaining<Partial<CompanionActionHttpError>>({
        status: 410,
        code: 'cursor_expired',
        retryable: false,
      }),
    );
  });

  it('bounds each Companion request independently of the overall sync budget', async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      }));
    const client = createCompanionActionClient({
      baseUrl: 'https://companion.example',
      credential: 'credential',
      trustedMissionControlOrigin: 'https://mission-control.example',
      fetchImpl,
      maxRetries: 0,
      requestTimeoutMs: 5,
    });

    await expect(client.fetchPageV2(null)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('submits only canonical V2 mutations and verifies receipt identity', async () => {
    const request = {
      contractVersion: '2.0' as const,
      operationId: '10000000-0000-4000-8000-000000000005',
      actionId: ACTION_ID,
      baseRevision: 1,
      mutation: { kind: 'action.lifecycle' as const, state: 'handled' as const },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      operationId: request.operationId,
      actionId: request.actionId,
      outcome: 'applied',
      revision: 2,
    }), { status: 200 }));
    const client = createCompanionActionClient({
      baseUrl: 'https://companion.example',
      credential: 'credential',
      trustedMissionControlOrigin: 'https://mission-control.example',
      fetchImpl,
      maxRetries: 0,
    });

    await expect(client.submitMutationV2(request)).resolves.toMatchObject({
      outcome: 'applied',
      revision: 2,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://companion.example/v2/integrations/action-feed/mutations',
    );
  });
});
