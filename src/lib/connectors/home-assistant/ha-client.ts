/**
 * Home Assistant REST and bounded WebSocket API client.
 */

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HomeAssistantPersistentNotification {
  notification_id: string;
  title?: string;
  message?: string;
  status?: string;
  created_at?: string;
}

export interface HomeAssistantRepairIssue {
  domain: string;
  issue_id: string;
  severity?: string;
  ignored?: boolean;
  is_fixable?: boolean;
  is_persistent?: boolean;
  title?: string;
  description?: string;
  translation_key?: string;
  created?: string;
}

export interface HomeAssistantSourceProbe {
  available: boolean;
  count?: number;
  error?: string;
}

export interface HomeAssistantConnectionResult {
  ok: boolean;
  serviceCount?: number;
  version?: string;
  status?: number;
  error?: string;
  sources?: {
    states: HomeAssistantSourceProbe;
    persistentNotifications: HomeAssistantSourceProbe;
    repairs: HomeAssistantSourceProbe;
  };
}

export interface HAClientOptions {
  baseUrl: string;
  accessToken: string;
}

export interface HAWebSocketSourceResult {
  persistentNotifications?: HomeAssistantPersistentNotification[];
  repairs?: HomeAssistantRepairIssue[];
  errors: Partial<Record<'persistentNotifications' | 'repairs', string>>;
}

export interface HAClient {
  fetchStates(): Promise<HomeAssistantState[]>;
  fetchWebSocketSources(
    sources: Array<'persistentNotifications' | 'repairs'>,
  ): Promise<HAWebSocketSourceResult>;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<void>;
  ignoreRepair(domain: string, issueId: string): Promise<void>;
  testConnection(): Promise<HomeAssistantConnectionResult>;
}

type WebSocketCommand = {
  key: 'persistentNotifications' | 'repairs' | 'repairAction';
  message: Record<string, unknown>;
};

type WebSocketLike = {
  close(): void;
  send(data: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

function websocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/websocket`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView<ArrayBuffer>);
  }
  return String(data);
}

async function runWebSocketCommands(
  options: HAClientOptions,
  commands: WebSocketCommand[],
): Promise<Record<string, unknown>> {
  if (commands.length === 0) return {};
  if (typeof WebSocket === 'undefined') {
    throw new Error('Home Assistant WebSocket support is unavailable in this runtime');
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl(options.baseUrl)) as unknown as WebSocketLike;
    const results: Record<string, unknown> = {};
    const pending = new Map<number, WebSocketCommand>();
    let authenticated = false;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error('Home Assistant WebSocket request timed out'));
    }, 12_000);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        // Socket may already be closed after a transport error.
      }
      if (error) reject(error);
      else resolve(results);
    }

    socket.onopen = () => undefined;
    socket.onerror = () => finish(new Error('Home Assistant WebSocket connection failed'));
    socket.onclose = () => {
      if (!settled) finish(new Error('Home Assistant WebSocket closed before completing requests'));
    };
    socket.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(messageText(event.data)) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        message = parsed as Record<string, unknown>;
      } catch {
        finish(new Error('Home Assistant WebSocket returned invalid JSON'));
        return;
      }

      if (message.type === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: options.accessToken }));
        return;
      }
      if (message.type === 'auth_invalid') {
        finish(new Error('Home Assistant WebSocket authentication failed'));
        return;
      }
      if (message.type === 'auth_ok') {
        authenticated = true;
        commands.forEach((command, index) => {
          const id = index + 1;
          pending.set(id, command);
          socket.send(JSON.stringify({ id, ...command.message }));
        });
        return;
      }
      if (!authenticated || typeof message.id !== 'number') return;

      const command = pending.get(message.id);
      if (!command || message.type !== 'result') return;
      pending.delete(message.id);
      if (message.success === true) {
        results[command.key] = message.result;
      } else {
        const error = message.error;
        const errorMessage = error && typeof error === 'object' && !Array.isArray(error)
          && typeof (error as Record<string, unknown>).message === 'string'
          ? String((error as Record<string, unknown>).message)
          : 'Home Assistant rejected the WebSocket command';
        results[`${command.key}Error`] = errorMessage;
      }
      if (pending.size === 0) finish();
    };
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function createHAClient(options: HAClientOptions): HAClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  function buildHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...buildHeaders(), ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Home Assistant request failed: HTTP ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }

  return {
    async fetchStates(): Promise<HomeAssistantState[]> {
      return asArray(await fetchJson('/api/states')) as HomeAssistantState[];
    },

    async fetchWebSocketSources(sources): Promise<HAWebSocketSourceResult> {
      const commands: WebSocketCommand[] = sources.map(source => (
        source === 'persistentNotifications'
          ? { key: source, message: { type: 'persistent_notification/get' } }
          : { key: source, message: { type: 'repairs/list_issues' } }
      ));
      const result = await runWebSocketCommands(options, commands);
      const repairsPayload = result.repairs;
      const repairs = repairsPayload && typeof repairsPayload === 'object' && !Array.isArray(repairsPayload)
        ? asArray((repairsPayload as Record<string, unknown>).issues)
        : asArray(repairsPayload);
      return {
        ...(sources.includes('persistentNotifications') && !result.persistentNotificationsError
          ? { persistentNotifications: asArray(result.persistentNotifications) as HomeAssistantPersistentNotification[] }
          : {}),
        ...(sources.includes('repairs') && !result.repairsError
          ? { repairs: repairs as HomeAssistantRepairIssue[] }
          : {}),
        errors: {
          ...(typeof result.persistentNotificationsError === 'string'
            ? { persistentNotifications: result.persistentNotificationsError }
            : {}),
          ...(typeof result.repairsError === 'string' ? { repairs: result.repairsError } : {}),
        },
      };
    },

    async callService(domain, service, data): Promise<void> {
      await fetchJson(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    async ignoreRepair(domain, issueId): Promise<void> {
      const result = await runWebSocketCommands(options, [{
        key: 'repairAction',
        message: {
          type: 'repairs/ignore_issue',
          domain,
          issue_id: issueId,
          ignore: true,
        },
      }]);
      if (typeof result.repairActionError === 'string') {
        throw new Error(result.repairActionError);
      }
    },

    async testConnection(): Promise<HomeAssistantConnectionResult> {
      try {
        const [servicesResult, statesResult, websocketResult] = await Promise.allSettled([
          fetchJson('/api/services'),
          fetchJson('/api/states'),
          runWebSocketCommands(options, [
            { key: 'persistentNotifications', message: { type: 'persistent_notification/get' } },
            { key: 'repairs', message: { type: 'repairs/list_issues' } },
          ]),
        ]);
        if (servicesResult.status === 'rejected') {
          return { ok: false, error: servicesResult.reason instanceof Error ? servicesResult.reason.message : String(servicesResult.reason) };
        }
        const services = asArray(servicesResult.value);
        const states = statesResult.status === 'fulfilled' ? asArray(statesResult.value) : [];
        const websocket = websocketResult.status === 'fulfilled' ? websocketResult.value : {};
        const repairResult = websocket.repairs;
        const repairs = repairResult && typeof repairResult === 'object' && !Array.isArray(repairResult)
          ? asArray((repairResult as Record<string, unknown>).issues)
          : asArray(repairResult);
        return {
          ok: true,
          serviceCount: services.length,
          sources: {
            states: statesResult.status === 'fulfilled'
              ? { available: true, count: states.length }
              : { available: false, error: 'State API unavailable' },
            persistentNotifications: websocketResult.status === 'fulfilled'
              && typeof websocket.persistentNotificationsError !== 'string'
              ? { available: true, count: asArray(websocket.persistentNotifications).length }
              : { available: false, error: 'Persistent notifications unavailable' },
            repairs: websocketResult.status === 'fulfilled'
              && typeof websocket.repairsError !== 'string'
              ? { available: true, count: repairs.length }
              : { available: false, error: 'Repairs unavailable' },
          },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
