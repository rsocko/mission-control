import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reconcileScoutTasks, actOnSuggestion } = vi.hoisted(() => ({
  reconcileScoutTasks: vi.fn(),
  actOnSuggestion: vi.fn(),
}));

vi.mock('@/lib/connectors/scout/reconciliation-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/scout/reconciliation-service')>();
  return {
    ...actual,
    reconcileScoutTasks,
    actOnReconciliationSuggestion: actOnSuggestion,
  };
});

import { POST as reconcile } from '@/app/api/scout/reconcile/route';
import { POST as act } from '@/app/api/scout/reconciliation/suggestions/[id]/route';
import { ScoutReconciliationError } from '@/lib/connectors/scout/reconciliation-service';

function reconcileRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('https://mc.example/api/scout/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

function actionRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://mc.example/api/scout/reconciliation/suggestions/suggestion-1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('Scout reconciliation API', () => {
  beforeEach(() => {
    reconcileScoutTasks.mockReset();
    actOnSuggestion.mockReset();
  });

  afterEach(() => {
    delete process.env.MC_API_KEY;
  });

  it('requires configured API credentials', async () => {
    process.env.MC_API_KEY = 'trusted-key';
    const response = await reconcile(reconcileRequest('{}'));

    expect(response.status).toBe(401);
    expect(reconcileScoutTasks).not.toHaveBeenCalled();
  });

  it('accepts authenticated structured requests', async () => {
    process.env.MC_API_KEY = 'trusted-key';
    reconcileScoutTasks.mockResolvedValue({
      runId: 'run-1',
      idempotentReplay: false,
      dryRun: true,
      reconciled: [],
      summary: {
        autoCompleted: 0,
        suggestedComplete: 0,
        escalated: 0,
        unchanged: 0,
        ignoredSignals: 0,
      },
    });
    const body = { scope: 'task:task-1', dryRun: true, signals: [] };
    const response = await reconcile(reconcileRequest(JSON.stringify(body), {
      authorization: 'Bearer trusted-key',
    }));

    expect(response.status).toBe(200);
    expect(reconcileScoutTasks).toHaveBeenCalledWith(body);
  });

  it('returns validation and rate-limit failures without success-shaped output', async () => {
    reconcileScoutTasks.mockRejectedValueOnce(new ScoutReconciliationError('Invalid evidence', 400));
    const invalid = await reconcile(reconcileRequest('{}'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Invalid evidence' });

    reconcileScoutTasks.mockRejectedValueOnce(new ScoutReconciliationError('Run too frequent', 429, 120));
    const limited = await reconcile(reconcileRequest('{}'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('120');
    expect(await limited.json()).toEqual({ error: 'Run too frequent' });
  });

  it('protects proposal actions from cross-origin and changed payloads', async () => {
    const crossOrigin = await act(actionRequest({
      action: 'accept',
      payloadHash: 'a'.repeat(64),
    }, {
      'x-forwarded-host': 'mc.example',
      'x-forwarded-proto': 'https',
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
    }), { params: Promise.resolve({ id: 'suggestion-1' }) });
    expect(crossOrigin.status).toBe(401);
    expect(actOnSuggestion).not.toHaveBeenCalled();

    process.env.MC_API_KEY = 'trusted-key';
    const malformed = await act(actionRequest({
      action: 'accept',
      payloadHash: 'changed',
    }, {
      authorization: 'Bearer trusted-key',
    }), { params: Promise.resolve({ id: 'suggestion-1' }) });
    expect(malformed.status).toBe(400);
  });

  it('derives the actor server-side for authenticated confirmation', async () => {
    process.env.MC_API_KEY = 'trusted-key';
    actOnSuggestion.mockResolvedValue({ suggestionId: 'suggestion-1', status: 'accepted' });
    const response = await act(actionRequest({
      action: 'accept',
      payloadHash: 'a'.repeat(64),
    }, {
      authorization: 'Bearer trusted-key',
    }), { params: Promise.resolve({ id: 'suggestion-1' }) });

    expect(response.status).toBe(200);
    expect(actOnSuggestion).toHaveBeenCalledWith('suggestion-1', {
      action: 'accept',
      payloadHash: 'a'.repeat(64),
      actor: 'user',
    });
  });
});
