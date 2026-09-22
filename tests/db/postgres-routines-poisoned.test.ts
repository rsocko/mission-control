import { describe, expect, it, vi } from 'vitest';
import type { RoutinesRepository } from '@/db/persistence/routines';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const calls = vi.hoisted(() => ({
  createRoutine: vi.fn(async () => undefined),
  updateRoutine: vi.fn(async () => true),
  archiveRoutine: vi.fn(async () => true),
  createCompletion: vi.fn(async () => ({ outcome: 'created' as const })),
  deleteCompletionById: vi.fn(async () => undefined),
  deleteCompletionsForDate: vi.fn(async () => undefined),
}));

const routine = {
  id: 'routine-poison',
  name: 'Poison proof',
  description: null,
  cadenceType: 'daily' as const,
  cadenceConfig: {},
  icon: null,
  sortOrder: 0,
  isActive: true,
  isArchived: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const completion = {
  id: 'completion-poison',
  routineId: routine.id,
  date: '2026-09-05',
  notes: null,
  completedAt: '2026-09-05T12:00:00.000Z',
};
const repository: RoutinesRepository = {
  listRoutines: async () => [routine],
  getRoutine: async (id) => id === routine.id ? routine : null,
  createRoutine: calls.createRoutine,
  updateRoutine: calls.updateRoutine,
  archiveRoutine: calls.archiveRoutine,
  listCompletions: async () => [completion],
  createCompletion: calls.createCompletion,
  deleteCompletionById: calls.deleteCompletionById,
  deleteCompletionsForDate: calls.deleteCompletionsForDate,
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({ routines: repository }),
}));

const BASE = 'http://localhost:3099';

function request(path: string, init?: RequestInit) {
  return new Request(`${BASE}${path}`, init);
}

describe('poisoned-SQLite routines web surface', () => {
  it('serves collection and item lifecycle without evaluating SQLite', async () => {
    const [collection, item] = await Promise.all([
      import('@/app/api/routines/route'),
      import('@/app/api/routines/[id]/route'),
    ]);

    const listed = await collection.GET(request('/api/routines?date=2026-09-05'));
    expect(listed.status).toBe(200);
    expect((await listed.json()).routines[0]).toMatchObject({
      id: routine.id,
      streak: 1,
    });

    expect((await collection.POST(request('/api/routines', {
      method: 'POST',
      body: JSON.stringify({ name: 'Created', cadenceType: 'daily' }),
    }))).status).toBe(201);
    expect(calls.createRoutine).toHaveBeenCalled();

    const params = { params: Promise.resolve({ id: routine.id }) };
    expect((await item.PATCH(request(`/api/routines/${routine.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated' }),
    }), params)).status).toBe(200);
    expect((await item.DELETE(request(`/api/routines/${routine.id}`, {
      method: 'DELETE',
    }), params)).status).toBe(200);
  });

  it('serves completion list/create/delete without evaluating SQLite', async () => {
    const route = await import('@/app/api/routines/completions/route');
    expect((await route.GET(request(
      '/api/routines/completions?startDate=2026-09-01&endDate=2026-09-05',
    ))).status).toBe(200);
    expect((await route.POST(request('/api/routines/completions', {
      method: 'POST',
      body: JSON.stringify({ routineId: routine.id, date: '2026-09-05' }),
    }))).status).toBe(201);
    expect((await route.DELETE(request(
      `/api/routines/completions?id=${completion.id}`,
      { method: 'DELETE' },
    ))).status).toBe(200);
    expect((await route.DELETE(request(
      `/api/routines/completions?routineId=${routine.id}&date=2026-09-05`,
      { method: 'DELETE' },
    ))).status).toBe(200);
    expect(calls.deleteCompletionById).toHaveBeenCalledWith(completion.id);
    expect(calls.deleteCompletionsForDate).toHaveBeenCalledWith(routine.id, '2026-09-05');
  });
});
