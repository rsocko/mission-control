import { describe, expect, it } from 'vitest';
import {
  classifyCopilotSmokeError,
  CopilotSmokeError,
} from '@/lib/ai/copilot-runtime-errors';

describe('classifyCopilotSmokeError', () => {
  it.each([
    ['token expired', 'credential_expired'],
    ['credential revoked', 'credential_revoked'],
    ['HTTP 429 rate limit', 'quota_exhausted'],
    ['organization policy denied access', 'policy_denied'],
    ['subscription entitlement missing', 'entitlement_denied'],
    ['requested model is not available', 'model_unavailable'],
    ['HTTP 401 bad credentials', 'credential_invalid'],
  ] as const)('classifies %s safely', (message, code) => {
    const error = classifyCopilotSmokeError(new Error(message), 'request');
    expect(error.code).toBe(code);
  });

  it('never includes the source error or credential in the safe error', () => {
    const secret = 'github_pat_sensitive-value';
    const error = classifyCopilotSmokeError(
      new Error(`request exploded with ${secret}`),
      'request',
    );

    expect(error).toBeInstanceOf(CopilotSmokeError);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    expect(error.code).toBe('request_failed');
  });
});
