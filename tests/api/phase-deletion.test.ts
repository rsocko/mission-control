/**
 * Tests for PR #306 — Clear dangling startAfterPhaseId references on phase deletion
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteProjectPhase } = vi.hoisted(() => ({
  deleteProjectPhase: vi.fn(),
}));

vi.mock('@/lib/projects/organization-service', () => ({
  deleteProjectPhase,
}));

const BASE = 'http://localhost:3099';

beforeEach(() => {
  deleteProjectPhase.mockReset().mockResolvedValue(undefined);
});

describe('DELETE /api/project-phases/[id] — dangling reference cleanup (PR #306)', () => {
  it('delegates the atomic dependency and item cleanup to project administration', async () => {
    const { DELETE } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-A`, { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'phase-A' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(deleteProjectPhase).toHaveBeenCalledWith('phase-A');
  });

  it('does not execute a second persistence operation in the route', async () => {
    const { DELETE } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-B`, { method: 'DELETE' });
    await DELETE(request, { params: Promise.resolve({ id: 'phase-B' }) });

    expect(deleteProjectPhase).toHaveBeenCalledTimes(1);
  });

  it('returns 500 if the atomic repository operation fails', async () => {
    deleteProjectPhase.mockRejectedValueOnce(new Error('DB failure'));

    const { DELETE } = await import('@/app/api/project-phases/[id]/route');
    const request = new Request(`${BASE}/api/project-phases/phase-C`, { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'phase-C' }) });

    expect(response.status).toBe(500);
  });
});
