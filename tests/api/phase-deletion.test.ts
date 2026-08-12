/**
 * Tests for PR #306 — Clear dangling startAfterPhaseId references on phase deletion
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ─── Shared DB mock (chainable with transaction support) ─────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const txUpdateCalls: Array<{ set: Record<string, unknown>; where: unknown }> = [];
const txDeleteCalls: Array<{ table: string; where: unknown }> = [];

const mockTx = {
  update: vi.fn((_table: unknown) => {
    const call = { set: {} as Record<string, unknown>, where: undefined as unknown };
    txUpdateCalls.push(call);
    return {
      set: vi.fn((vals: Record<string, unknown>) => {
        call.set = vals;
        return {
          where: vi.fn((w: unknown) => {
            call.where = w;
            return { run: vi.fn() };
          }),
        };
      }),
    };
  }),
  delete: vi.fn((table: unknown) => {
    const call = { table: String(table), where: undefined as unknown };
    txDeleteCalls.push(call);
    return {
      where: vi.fn((w: unknown) => {
        call.where = w;
        return { run: vi.fn() };
      }),
    };
  }),
};

const mockDb = {
  select: vi.fn(() => chainable([])),
  insert: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable(undefined)),
  delete: vi.fn(() => chainable(undefined)),
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<void>) => {
    await fn(mockTx);
  }),
};

const mockRunTransaction = vi.fn((fn: (tx: typeof mockTx) => void) => {
  fn(mockTx);
});

vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: mockRunTransaction,
}));

vi.mock('@/db/schema', () => ({
  projectPhases: {
    id: 'id',
    projectId: 'project_id',
    name: 'name',
    startAfterPhaseId: 'start_after_phase_id',
    sortOrder: 'sort_order',
    completedAt: 'completed_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  projectPhaseItems: {
    id: 'id',
    phaseId: 'phase_id',
    taskId: 'task_id',
    sortOrder: 'sort_order',
  },
}));

vi.mock('@/lib/logger', () => ({
  dbLogger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    internal: vi.fn((msg: string) => {
      return NextResponse.json({ error: msg, code: 'INTERNAL_ERROR' }, { status: 500 });
    }),
  },
}));

const BASE = 'http://localhost:3099';

beforeEach(() => {
  txUpdateCalls.length = 0;
  txDeleteCalls.length = 0;
  mockTx.update.mockClear();
  mockTx.delete.mockClear();
});

describe('DELETE /api/project-phases/[id] — dangling reference cleanup (PR #306)', () => {
  it('should clear startAfterPhaseId on dependent phases before deleting', async () => {
    const { DELETE } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-A`, { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'phase-A' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // The transaction function should have been invoked (via runTransaction)
    expect(mockTx.update).toHaveBeenCalled();

    // First tx operation: clear startAfterPhaseId on dependent phases
    expect(txUpdateCalls.length).toBeGreaterThanOrEqual(1);
    expect(txUpdateCalls[0].set).toEqual({ startAfterPhaseId: null });

    // Then deletes: items first, then phase
    expect(txDeleteCalls.length).toBe(2);
  });

  it('should delete phase items before the phase itself', async () => {
    const { DELETE } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-B`, { method: 'DELETE' });
    await DELETE(request, { params: Promise.resolve({ id: 'phase-B' }) });

    // Order: update refs → delete items → delete phase
    expect(mockTx.update).toHaveBeenCalledTimes(1);
    expect(mockTx.delete).toHaveBeenCalledTimes(2);
  });

  it('should return 500 if the transaction fails', async () => {
    mockRunTransaction.mockImplementationOnce(() => { throw new Error('DB failure'); });

    const { DELETE } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-C`, { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'phase-C' }) });

    expect(response.status).toBe(500);
  });
});
