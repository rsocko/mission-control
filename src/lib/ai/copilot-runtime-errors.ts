export type CopilotSmokePhase =
  | 'configuration'
  | 'startup'
  | 'authentication'
  | 'entitlement'
  | 'model'
  | 'request'
  | 'shutdown';

export type CopilotSmokeFailureCode =
  | 'credential_missing'
  | 'credential_expired'
  | 'credential_revoked'
  | 'credential_invalid'
  | 'policy_denied'
  | 'entitlement_denied'
  | 'quota_exhausted'
  | 'model_unavailable'
  | 'runtime_startup_failed'
  | 'request_failed'
  | 'interrupted'
  | 'shutdown_failed'
  | 'configuration_invalid';

const SAFE_MESSAGES: Record<CopilotSmokeFailureCode, string> = {
  credential_missing: 'The deployment credential secret is missing or empty.',
  credential_expired: 'The deployment credential has expired.',
  credential_revoked: 'The deployment credential has been revoked.',
  credential_invalid: 'The deployment credential was rejected.',
  policy_denied: 'Copilot access was denied by enterprise or organization policy.',
  entitlement_denied: 'The service identity does not have the required Copilot entitlement.',
  quota_exhausted: 'The Copilot quota or rate limit is exhausted.',
  model_unavailable: 'The requested model is unavailable to the service identity.',
  runtime_startup_failed: 'The pinned Copilot runtime failed to start.',
  request_failed: 'The bounded Copilot smoke request failed.',
  interrupted: 'The Copilot smoke run was interrupted by the operator.',
  shutdown_failed: 'The Copilot runtime did not shut down cleanly.',
  configuration_invalid: 'The Copilot smoke runtime configuration is invalid.',
};

export class CopilotSmokeError extends Error {
  constructor(
    readonly code: CopilotSmokeFailureCode,
    readonly phase: CopilotSmokePhase,
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = 'CopilotSmokeError';
  }
}

function errorText(error: unknown): string {
  const values: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      values.push(current.name, current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      for (const key of ['code', 'status', 'statusCode', 'type']) {
        const value = record[key];
        if (typeof value === 'string' || typeof value === 'number') {
          values.push(String(value));
        }
      }
    }
    break;
  }

  return values.join(' ').toLowerCase();
}

export function classifyCopilotSmokeError(
  error: unknown,
  phase: CopilotSmokePhase,
): CopilotSmokeError {
  if (error instanceof CopilotSmokeError) return error;

  const text = errorText(error);
  if (/\b(expired|expiration)\b/.test(text)) {
    return new CopilotSmokeError('credential_expired', phase);
  }
  if (/\b(revoked|invalidated)\b/.test(text)) {
    return new CopilotSmokeError('credential_revoked', phase);
  }
  if (/\b(quota|rate.?limit|too many requests|premium requests|429)\b/.test(text)) {
    return new CopilotSmokeError('quota_exhausted', phase);
  }
  if (/\b(policy|organization).*(denied|blocked|disabled|not permitted)\b/.test(text)) {
    return new CopilotSmokeError('policy_denied', phase);
  }
  if (/\b(entitlement|subscription|not entitled|no copilot access)\b/.test(text)) {
    return new CopilotSmokeError('entitlement_denied', phase);
  }
  if (
    /\b(model).*(not found|not available|unavailable|unsupported|not enabled)\b/.test(text) ||
    /\bunsupported model\b/.test(text)
  ) {
    return new CopilotSmokeError('model_unavailable', phase);
  }
  if (/\b(bad credentials|unauthorized|invalid token|authentication failed|401)\b/.test(text)) {
    return new CopilotSmokeError('credential_invalid', phase);
  }

  const fallback: Record<CopilotSmokePhase, CopilotSmokeFailureCode> = {
    configuration: 'configuration_invalid',
    startup: 'runtime_startup_failed',
    authentication: 'credential_invalid',
    entitlement: 'entitlement_denied',
    model: 'model_unavailable',
    request: 'request_failed',
    shutdown: 'shutdown_failed',
  };
  return new CopilotSmokeError(fallback[phase], phase);
}
