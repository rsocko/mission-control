import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRoutineSkip: vi.fn(),
  deleteRoutineSkipForDate: vi.fn(),
}));

vi.mock('@/lib/routines/service', () => ({
  createRoutineSkip: mocks.createRoutineSkip,
  deleteRoutineSkipForDate: mocks.deleteRoutineSkipForDate,
}));
vi.mock('@/lib/utils/date', () => ({ getLocalToday: () => '2026-10-18' }));

function post(body: unknown) {
  return new Request('http://localhost/api/routines/skips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/routines/skips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRoutineSkip.mockResolvedValue({ outcome: 'created' });
    mocks.deleteRoutineSkipForDate.mockResolvedValue(undefined);
  });

  it('creates a date-scoped routine skip', async () => {
    const { POST } = await import('@/app/api/routines/skips/route');
    const response = await POST(post({ routineId: 'routine-1', date: '2026-10-18' }));

    expect(response.status).toBe(201);
    expect(mocks.createRoutineSkip).toHaveBeenCalledWith(expect.objectContaining({
      routineId: 'routine-1',
      date: '2026-10-18',
    }));
  });

  it.each([
    [{}, 400],
    [null, 400],
    [{ routineId: 'routine-1', date: '10/18/2026' }, 400],
  ])('rejects invalid skip input', async (body, status) => {
    const { POST } = await import('@/app/api/routines/skips/route');
    const response = await POST(post(body));

    expect(response.status).toBe(status);
    expect(mocks.createRoutineSkip).not.toHaveBeenCalled();
  });

  it('rejects skipping an already completed routine', async () => {
    mocks.createRoutineSkip.mockResolvedValue({ outcome: 'already-completed' });
    const { POST } = await import('@/app/api/routines/skips/route');
    const response = await POST(post({ routineId: 'routine-1' }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('cannot be skipped');
  });

  it('restores a skipped routine', async () => {
    const { DELETE } = await import('@/app/api/routines/skips/route');
    const response = await DELETE(new Request(
      'http://localhost/api/routines/skips?routineId=routine-1&date=2026-10-18',
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(200);
    expect(mocks.deleteRoutineSkipForDate).toHaveBeenCalledWith('routine-1', '2026-10-18');
  });
});
