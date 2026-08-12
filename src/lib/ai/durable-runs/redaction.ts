const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/gi,
  /\b(?:sk|pk)[_-][A-Za-z0-9_-]{12,}\b/gi,
  /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi,
] as const;
const ASSIGNED_SECRET_PATTERN =
  /(["']?\b(?:access[_-]?token|api[_-]?key|password|secret|credential|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi;

interface PayloadSchema {
  readonly [key: string]: true | PayloadSchema;
}

const ERROR_SCHEMA: PayloadSchema = {
  code: true,
  message: true,
};
const HOUSTON_ENVELOPE_SCHEMA: PayloadSchema = {
  schemaVersion: true,
  eventId: true,
  runId: true,
  correlationId: true,
  parentEventId: true,
  sequence: true,
  timestamp: true,
  observedAt: true,
  kind: true,
  executionRoute: true,
  featureId: true,
  sensitivity: true,
  provider: {
    name: true,
    model: true,
  },
  source: {
    boundary: true,
    eventType: true,
    delivery: true,
    ephemeral: true,
  },
  trace: {
    traceId: true,
    spanId: true,
    parentSpanId: true,
  },
};
const LIFECYCLE_SCHEMA: PayloadSchema = {
  lifecycleState: true,
  terminalState: true,
};
const USAGE_SCHEMA: PayloadSchema = {
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  reasoningTokens: true,
  totalNanoAiu: true,
  durationMs: true,
  timeToFirstTokenMs: true,
  interTokenLatencyMs: true,
  finishReason: true,
  endpoint: true,
  contentFilterTriggered: true,
};
const FAILURE_SCHEMA: PayloadSchema = {
  category: true,
  code: true,
  statusCode: true,
  failureKind: true,
  source: true,
  transport: true,
};
const TOOL_SCHEMA: PayloadSchema = {
  identifier: true,
  callCorrelationId: true,
  permissionDecision: true,
  outcome: true,
  durationMs: true,
};

function houstonEventSchema(extra: PayloadSchema = {}): PayloadSchema {
  return { ...HOUSTON_ENVELOPE_SCHEMA, ...extra };
}

const HOUSTON_EVENT_SCHEMAS: Readonly<Record<string, PayloadSchema>> = {
  'run.started': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.resuming': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.attached': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.detached': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.active': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.idle': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.terminal': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.cleanup_started': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.cleanup_completed': houstonEventSchema(LIFECYCLE_SCHEMA),
  'run.cleanup_failed': houstonEventSchema(LIFECYCLE_SCHEMA),
  'output.started': houstonEventSchema(),
  'output.progress': houstonEventSchema({ progressBytes: true }),
  'output.completed': houstonEventSchema({
    usage: { outputTokens: true },
  }),
  'reasoning.started': houstonEventSchema(),
  'reasoning.progress': houstonEventSchema({ progressBytes: true }),
  'reasoning.completed': houstonEventSchema(),
  'model.started': houstonEventSchema(),
  'model.completed': houstonEventSchema(),
  'model.retry': houstonEventSchema(),
  'model.usage': houstonEventSchema({ usage: USAGE_SCHEMA }),
  'model.failed': houstonEventSchema({ failure: FAILURE_SCHEMA }),
  'tool.requested': houstonEventSchema({ tool: TOOL_SCHEMA }),
  'tool.started': houstonEventSchema({ tool: TOOL_SCHEMA }),
  'tool.progress': houstonEventSchema({ tool: TOOL_SCHEMA }),
  'tool.completed': houstonEventSchema({ tool: TOOL_SCHEMA }),
  'tool.decision': houstonEventSchema({ tool: TOOL_SCHEMA }),
  'run.cancel_observed': houstonEventSchema(),
  'provider.error': houstonEventSchema({ failure: FAILURE_SCHEMA }),
  'provider.shutdown': houstonEventSchema(),
  'provider.task_completed': houstonEventSchema(),
  'model.changed': houstonEventSchema(),
};
const STORE_EVENT_SCHEMAS: Readonly<Record<string, PayloadSchema>> = {
  'run.queued': {
    featureId: true,
    executionRoute: true,
  },
  'run.started': { attempt: true },
  'run.retry_requested': { previousStatus: true },
  'run.retry_scheduled': {
    attempt: true,
    code: true,
    availableAt: true,
  },
  'run.succeeded': { attempt: true, error: ERROR_SCHEMA },
  'run.failed': { attempt: true, error: ERROR_SCHEMA },
  'run.cancelled': { attempt: true, error: ERROR_SCHEMA },
  'run.timed_out': { attempt: true, error: ERROR_SCHEMA },
  'run.recovered': { attempt: true },
  'run.cleanup_failed': { error: ERROR_SCHEMA },
  'output.progress': { bytes: true },
};

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'argument',
  'arguments',
  'authorization',
  'body',
  'completion',
  'content',
  'credential',
  'credentials',
  'message',
  'messages',
  'password',
  'privatekey',
  'prompt',
  'reasoning',
  'request',
  'response',
  'result',
  'secret',
  'sessionid',
  'sessionreference',
  'stack',
  'token',
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isForbiddenPayloadKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return FORBIDDEN_PAYLOAD_KEYS.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('credential')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('sessionid')
    || normalized.endsWith('sessionreference');
}

export function redactDurableAiText(value: string, maxLength = 500): string {
  let redacted = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]');
  }
  redacted = redacted.replace(ASSIGNED_SECRET_PATTERN, '$1[redacted]');
  return redacted.slice(0, maxLength);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return redactDurableAiText(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value !== 'object') return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (isForbiddenPayloadKey(key)) continue;
    const safeEntry = sanitizeValue(entry, depth + 1);
    if (safeEntry !== undefined) sanitized[key.slice(0, 100)] = safeEntry;
  }
  return sanitized;
}

export function sanitizeDurableAiEventPayload(
  kind: string,
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const storeSchema = STORE_EVENT_SCHEMAS[kind];
  const houstonSchema = HOUSTON_EVENT_SCHEMAS[kind];
  const schema = houstonSchema
    ? { ...houstonSchema, ...storeSchema }
    : storeSchema;
  if (!schema) return {};
  return sanitizeAllowlistedValue(payload ?? {}, schema, 0);
}

function sanitizeAllowlistedValue(
  value: unknown,
  schema: PayloadSchema,
  depth: number,
): Record<string, unknown> {
  if (
    depth > 4
    || value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema)) {
    const entry = source[key];
    if (entry === undefined) continue;
    if (fieldSchema === true) {
      if (entry === null || typeof entry === 'boolean') {
        sanitized[key] = entry;
      } else if (typeof entry === 'number' && Number.isFinite(entry)) {
        sanitized[key] = entry;
      } else if (typeof entry === 'string') {
        sanitized[key] = redactDurableAiText(entry);
      }
      continue;
    }
    const nested = sanitizeAllowlistedValue(entry, fieldSchema, depth + 1);
    if (Object.keys(nested).length > 0) sanitized[key] = nested;
  }
  return sanitized;
}

export function sanitizeDurableAiState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(state, 0) as Record<string, unknown>;
}
