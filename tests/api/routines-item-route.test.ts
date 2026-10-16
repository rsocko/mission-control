import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRoutine: vi.fn(),
  updateRoutine: vi.fn(),
}));

vi.mock('@/lib/routines/service', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/routines/service')>();
  return {
    ...original,
    getRoutine: mocks.getRoutine,
    updateRoutine: mocks.updateRoutine,
  };
});

const existing = {
  id: 'routine-1',
  name: 'Morning walk',
  description: null,
  icon: null,
  cadenceType: 'daily' as const,
  cadenceConfig: {},
  sortOrder: 0,
  isActive: true,
  isArchived: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function patch(body: unknown) {
  return new Request('http://localhost/api/routines/routine-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/routines/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRoutine.mockResolvedValue(existing);
    mocks.updateRoutine.mockResolvedValue(true);
  });

  it('trims and updates valid editable fields', async () => {
    const { PATCH } = await import('@/app/api/routines/[id]/route');
    const response = await PATCH(
      patch({ name: '  Evening walk  ', cadenceType: 'x_per_week', cadenceConfig: { target: 4 } }),
      { params: Promise.resolve({ id: existing.id }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.updateRoutine).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      updates: {
        name: 'Evening walk',
        cadenceType: 'x_per_week',
        cadenceConfig: { target: 4 },
      },
    }));
  });

  it.each([
    [{ name: '   ' }, 'name must be a non-empty string'],
    [{ cadenceType: 'unknown' }, 'Invalid cadenceType'],
    [{ cadenceType: 'specific_days', cadenceConfig: { days: [] } }, 'at least one valid day'],
    [{ cadenceType: 'x_per_week', cadenceConfig: { target: 8 } }, 'between 1 and 7'],
    [{ cadenceType: 'every_n_days', cadenceConfig: { minDays: 5, maxDays: 2 } }, 'maxDays'],
  ])('rejects invalid updates: %o', async (body, expectedError) => {
    const { PATCH } = await import('@/app/api/routines/[id]/route');
    const response = await PATCH(patch(body), { params: Promise.resolve({ id: existing.id }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(expectedError);
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });

  it('rejects a non-object request body', async () => {
    const { PATCH } = await import('@/app/api/routines/[id]/route');
    const response = await PATCH(patch('invalid'), { params: Promise.resolve({ id: existing.id }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('must be an object');
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });
});
