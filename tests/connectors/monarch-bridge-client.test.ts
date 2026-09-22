import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
} from '@/lib/connectors/monarch-money/client';
import {
  getTyrionBridgeUrl,
  normalizeTyrionBridgeUrl,
  TyrionBridgeUrlValidationError,
} from '@/lib/connectors/monarch-money/bridge-url';
import { DEFAULT_TYRION_PRODUCTION_BRIDGE_URL } from '@/lib/connectors/monarch-money/constants';

const config: ConnectorConfig = {
  id: 'finance-test',
  type: 'finance-manager',
  name: 'Finance test',
  enabled: true,
  syncMode: 'poll',
  capabilities: {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: false,
    tags: true,
    tagWriteBack: true,
  },
  credentials: { serviceToken: 'invented-service-token' },
  settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 1 },
  syncedLists: [],
};

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-monarch-contract-version': '1.0',
      ...extraHeaders,
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MonarchBridgeClient', () => {
  it('authenticates server-side and accepts nullable v1 transaction fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: '1.0',
      provenance: { provider: 'live', fetchedAt: '2026-08-01T12:00:00.000Z' },
      transactions: [{
        id: 'tx-1',
        date: '2026-08-01',
        amount: -12.5,
        merchant: { name: 'Invented Market', logoUrl: null },
        category: null,
        account: { id: 'acct-1', displayName: 'Invented Card', mask: null },
        isPending: true,
        isRecurring: false,
        notes: null,
        tags: [],
        tagReferences: [],
      }],
      total: 1,
      page: { limit: 500, nextCursor: null },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new MonarchBridgeClient(config).getTransactionsPage({
      startDate: '2026-08-01',
      endDate: '2026-08-01',
      limit: 500,
    });

    expect(result.transactions[0]).toMatchObject({
      category: null,
      notes: null,
      isPending: true,
      isRecurring: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/transactions?'),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer invented-service-token',
        }),
      }),
    );
  });

  it('sends the v1 category payload and validates the echoed identifiers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: '1.0',
      status: 'updated',
      transactionId: 'tx-1',
      categoryId: 'category-2',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new MonarchBridgeClient(config).updateCategory('tx-1', 'category-2');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8100/transactions/tx-1/category',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ categoryId: 'category-2' }),
      }),
    );
  });

  it('runs only the bounded server-authenticated recovery sync with no request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: '1.0',
      status: 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new MonarchBridgeClient(config).runBoundedSync(30);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8100/sync?days=30',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer .+/);
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('content-type')).toBe(false);
    await expect(new MonarchBridgeClient(config).runBoundedSync(0)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('rejects an invalid contract without exposing the response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: '2.0',
      secret: 'must-not-leak',
    })));

    await expect(new MonarchBridgeClient(config).getHealth()).rejects.toMatchObject({
      code: 'invalid_contract',
      message: expect.not.stringContaining('must-not-leak'),
    });
  });

  it('retries rate limits and honors Retry-After before succeeding', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        contractVersion: '1.0',
        error: { code: 'upstream_rate_limited', message: 'invented detail' },
      }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({
        contractVersion: '1.0',
        status: 'ok',
        mode: 'live',
        reachable: true,
        authenticated: true,
        authState: 'connected',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = new MonarchBridgeClient(config).getHealth();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ authenticated: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a non-JSON server failure before validating the success contract', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('temporary upstream failure', {
        status: 503,
        headers: { 'retry-after': '0' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        contractVersion: '1.0',
        status: 'ok',
        mode: 'live',
        reachable: true,
        authenticated: true,
        authState: 'connected',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = new MonarchBridgeClient(config).getHealth();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['plain-text 502 proxy failure', 502, 'Bad Gateway', 'text/plain'],
    ['HTML 504 proxy failure', 504, '<html><title>Gateway Timeout</title></html>', 'text/html'],
    ['empty JSON response', 502, '', 'application/json'],
    ['malformed JSON', 502, '{"error":', 'application/json'],
  ])('sanitizes a %s as connector unavailable', async (_case, status, body, contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      status,
      headers: { 'content-type': contentType },
    })));

    const error = await new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    }).getHealth().catch((value) => value);

    expect(error).toMatchObject({
      code: 'bridge_unavailable',
      retryable: true,
      status,
      message: 'Monarch Bridge is unavailable',
    });
    if (body) expect(JSON.stringify(error)).not.toContain(body);
  });

  it('sanitizes an oversized streamed JSON response as connector unavailable', async () => {
    const oversizedChunk = new Uint8Array(16 * 1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(oversizedChunk);
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    }).getHealth()).rejects.toMatchObject({
      code: 'bridge_unavailable',
      retryable: true,
      status: 502,
    });
  });

  it('rejects redirect responses without forwarding or exposing credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      redirected: true,
      status: 302,
      url: 'https://attacker.invalid/capture?transaction=private-id',
      headers: new Headers({ location: 'https://attacker.invalid/capture' }),
      body: null,
    } satisfies Partial<Response>);
    vi.stubGlobal('fetch', fetchMock);

    const error = await new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    }).getHealth().catch((value) => value);

    expect(error).toMatchObject({
      code: 'bridge_unavailable',
      retryable: true,
      status: 302,
    });
    expect(error.message).not.toContain('attacker.invalid');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it.each([
    [401, 'connector_auth_required', false],
    [401, 'connector_auth_invalid', false],
    [502, 'invalid_bridge_response', true],
    [429, 'upstream_rate_limited', true],
  ])('preserves the valid gateway error %s', async (status, code, retryable) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code, message: 'private upstream detail' },
    }), {
      status,
      headers: { 'content-type': 'application/json' },
    })));

    const error = await new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    }).getHealth().catch((value) => value);

    expect(error).toMatchObject({ code, retryable, status });
    expect(error.message).not.toContain('private upstream detail');
  });

  it('does not expose an unrecognized error code from an upstream body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'private_account_identifier', message: 'private financial detail' },
    }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    }).getHealth()).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: true,
      status: 502,
    });
  });

  it('classifies transport failures as retryable sanitized bridge errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private transport detail')));

    await expect(new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    }).getHealth()).rejects.toEqual(expect.objectContaining<Partial<MonarchBridgeError>>({
      code: 'bridge_unavailable',
      retryable: true,
      message: 'Monarch Bridge is unavailable',
    }));
  });

  it('classifies a bounded request timeout without leaking transport details', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('invented timeout transport detail'));
        }, { once: true });
      })));

    await expect(new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', timeoutMs: 1, maxRetries: 0 },
    }).getHealth()).rejects.toMatchObject({
      code: 'upstream_timeout',
      retryable: true,
      message: 'Monarch Bridge request timed out',
    });
  });

  it('classifies a timeout while reading the response body', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) =>
      Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new Error('private body stream detail'));
          }, { once: true });
        },
      }), {
        headers: { 'content-type': 'application/json' },
      }))));

    await expect(new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', timeoutMs: 1, maxRetries: 0 },
    }).getHealth()).rejects.toMatchObject({
      code: 'upstream_timeout',
      retryable: true,
      message: 'Monarch Bridge request timed out',
    });
  });

  it('preserves caller cancellation while reading the response body', async () => {
    const controller = new AbortController();
    const cancellation = new Error('Sync cancelled by caller');
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) =>
      Promise.resolve(new Response(new ReadableStream({
        start(streamController) {
          init?.signal?.addEventListener('abort', () => {
            streamController.error(new Error('private body stream detail'));
          }, { once: true });
        },
      }), {
        headers: { 'content-type': 'application/json' },
      }))));

    const request = new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    }).getHealth(controller.signal);
    controller.abort(cancellation);

    await expect(request).rejects.toBe(cancellation);
  });

  it('joins requests beneath the persisted private bridge base path in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: '1.0',
      status: 'ok',
      mode: 'live',
      reachable: true,
      authenticated: true,
      authState: 'connected',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://custom-tyrion-bridge:8100/bridge/v1/' },
    }).getHealth();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://custom-tyrion-bridge:8100/bridge/v1/health',
      expect.any(Object),
    );
  });

  it('uses environment-appropriate portable defaults', () => {
    expect(getTyrionBridgeUrl({}, { NODE_ENV: 'development' }))
      .toBe('http://localhost:8100');
    expect(getTyrionBridgeUrl({}, { NODE_ENV: 'production' }))
      .toBe(DEFAULT_TYRION_PRODUCTION_BRIDGE_URL);
  });

  it('permits custom HTTPS base paths and canonicalizes them', () => {
    expect(normalizeTyrionBridgeUrl(' https://bridge.example.test:443/custom/v1/ '))
      .toBe('https://bridge.example.test/custom/v1');
    expect(normalizeTyrionBridgeUrl('https://tyrion.example./api/connector/v1/'))
      .toBe(DEFAULT_TYRION_PRODUCTION_BRIDGE_URL);
  });

  it.each([
    ['https://tyrion.example', '/api/connector/v1', ''],
    ['https://tyrion.example/api/bridge', '/api/connector/v1', ''],
    ['http://tyrion-operations-ui:3000/api/connector/v1', 'operations UI', ''],
    ['http://tyrion-operations-ui.local/api/connector/v1', 'operations UI', ''],
    ['https://tyrion-operations-ui-1/api/connector/v1', 'operations UI', ''],
    ['http://bridge.example.test/v1', 'must use HTTPS', ''],
    ['http://user:password@localhost:8100', 'must not contain credentials', ''],
    ['http://localhost:8100?token=1', 'must not contain credentials', ''],
    ['http://localhost:8100/v1/../private', 'traversal', ''],
    ['http://localhost:8100/v1/%252e%252e/private', 'nested encoding', ''],
    ['http://localhost:8100/v1/%25252e%25252e/private', 'nested encoding', ''],
    ['http://localhost:8100/v1%2fprivate', 'encoded separators', ''],
    ['http://169.254.169.254', 'link-local', ''],
    ['https://169.254.169.254/v1', 'link-local', ''],
    ['http://[fe80::1]', 'link-local', ''],
    ['https://[febf::1]/v1', 'link-local', ''],
    ['https://[::ffff:169.254.169.254]/v1', 'link-local', ''],
    ['ftp://localhost:8100', 'HTTP or HTTPS', ''],
  ])('rejects unsafe bridge base URL %s', (bridgeUrl, expectedMessage) => {
    expect(() => normalizeTyrionBridgeUrl(bridgeUrl))
      .toThrow(expect.objectContaining<Partial<TyrionBridgeUrlValidationError>>({
        code: 'invalid_bridge_url',
        message: expect.stringContaining(expectedMessage),
      }));
  });

  it.each([
    'https://attacker.invalid/v1/../capture',
    'https://169.254.169.254/v1',
    'https://[::ffff:169.254.169.254]/v1',
    'https://tyrion-operations-ui-1/api/connector/v1',
  ])('rejects unsafe persisted base %s before any credential can be sent', (bridgeUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl },
    })).toThrow(expect.objectContaining<Partial<MonarchBridgeError>>({
      code: 'invalid_bridge_url',
      retryable: false,
      status: 400,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails before fetch with a sanitized server-credential error when no token exists', async () => {
    vi.stubEnv('FINANCE_MANAGER_API_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => new MonarchBridgeClient({
      ...config,
      credentials: {},
      settings: { bridgeUrl: 'http://localhost:8100' },
    })).toThrow(expect.objectContaining<Partial<MonarchBridgeError>>({
      code: 'missing_server_credential',
      message: 'Tyrion service token is not configured',
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['serviceToken', 'bridgeToken', 'apiToken'])(
    'retains bounded migration support for the persisted %s alias',
    async (alias) => {
      vi.stubEnv('FINANCE_MANAGER_API_TOKEN', '');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        contractVersion: '1.0',
        status: 'ok',
        mode: 'live',
        reachable: true,
        authenticated: true,
        authState: 'connected',
      }));
      vi.stubGlobal('fetch', fetchMock);

      await new MonarchBridgeClient({
        ...config,
        credentials: { [alias]: 'invented-legacy-token' },
      }).getHealth();

      const authorization = new Headers(fetchMock.mock.calls[0][1].headers).get('authorization');
      expect(authorization).toMatch(/^Bearer /);
      expect(authorization?.endsWith('invented-legacy-token')).toBe(true);
    },
  );

  it('prefers the connector token over the optional server fallback', async () => {
    vi.stubEnv('FINANCE_MANAGER_API_TOKEN', 'invented-server-token');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: '1.0',
      status: 'ok',
      mode: 'live',
      reachable: true,
      authenticated: true,
      authState: 'connected',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new MonarchBridgeClient(config).getHealth();

    const authorization = new Headers(fetchMock.mock.calls[0][1].headers).get('authorization');
    expect(authorization).toMatch(/^Bearer /);
    expect(authorization?.endsWith('invented-service-token')).toBe(true);
    expect(authorization).not.toContain('invented-server-token');
  });

  it('validates the additive bounded reference and snapshot contracts', async () => {
    const bodies: Record<string, unknown> = {
      '/accounts': {
        contractVersion: '1.0',
        provenance: { provider: 'live', fetchedAt: '2026-08-10T12:00:00.000Z' },
        accounts: [{
          id: 'account-1',
          displayName: 'Invented account',
          type: 'checking',
          mask: null,
          institution: null,
          currentBalance: 0,
          isActive: true,
        }],
      },
      '/category-groups': {
        contractVersion: '1.0',
        provenance: { provider: 'live', fetchedAt: '2026-08-10T12:00:00.000Z' },
        categoryGroups: [{ id: 'group-1', name: 'Living', isActive: true }],
      },
      '/categories': {
        contractVersion: '1.0',
        provenance: { provider: 'live', fetchedAt: '2026-08-10T12:00:00.000Z' },
        categories: [{
          id: 'category-1',
          name: 'Groceries',
          groupId: 'group-1',
          group: 'Living',
          icon: null,
          isActive: true,
        }],
      },
      '/tags': {
        contractVersion: '1.0',
        provenance: { provider: 'live', fetchedAt: '2026-08-10T12:00:00.000Z' },
        tags: [{ id: 'tag-1', name: 'Household', isActive: true }],
      },
      '/recurring': {
        contractVersion: '1.0',
        provenance: { provider: 'live', fetchedAt: '2026-08-10T12:00:00.000Z' },
        recurring: [],
      },
      '/budgets': {
        contractVersion: '1.0',
        provenance: { provider: 'live', fetchedAt: '2026-08-10T12:00:00.000Z' },
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        budgets: [],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) =>
      jsonResponse(bodies[new URL(String(input)).pathname])));
    const client = new MonarchBridgeClient(config);

    await expect(client.getAccounts()).resolves.toMatchObject({
      accounts: [{ id: 'account-1', currentBalance: 0 }],
    });
    await expect(client.getCategoryGroups()).resolves.toMatchObject({
      categoryGroups: [{ id: 'group-1' }],
    });
    await expect(client.getCategories()).resolves.toMatchObject({
      categories: [{ groupId: 'group-1', group: 'Living' }],
    });
    await expect(client.getTags()).resolves.toMatchObject({ tags: [{ id: 'tag-1' }] });
    await expect(client.getRecurring()).resolves.toMatchObject({ recurring: [] });
    await expect(client.getBudgets()).resolves.toMatchObject({
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      budgets: [],
    });
  });

  it('rejects oversized datasets with a sanitized 502 contract error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: '1.0',
      provenance: { provider: 'live', fetchedAt: '2026-08-10T12:00:00.000Z' },
      categoryGroups: Array.from({ length: 251 }, (_, index) => ({
        id: `group-${index}`,
        name: 'Invented group',
        isActive: true,
      })),
      privateDetail: 'must-not-leak',
    })));

    await expect(new MonarchBridgeClient(config).getCategoryGroups())
      .rejects.toMatchObject({
        code: 'invalid_contract',
        status: 502,
        message: expect.not.stringContaining('must-not-leak'),
      });
  });

  it('sanitizes a declared response body above the byte limit before parsing it', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      cancel,
    }), {
      headers: {
        'content-length': String(16 * 1024 * 1024 + 1),
        'content-type': 'application/json',
        'x-monarch-contract-version': '1.0',
      },
    })));

    await expect(new MonarchBridgeClient({
      ...config,
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
    }).getAccounts()).rejects.toMatchObject({
      code: 'bridge_unavailable',
      status: 200,
      retryable: true,
      message: 'Monarch Bridge is unavailable',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
