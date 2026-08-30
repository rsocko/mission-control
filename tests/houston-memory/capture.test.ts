import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureHoustonMemory } from '@/lib/houston-memory/capture';

const {
  getHoustonMemorySettings,
  inspectHoustonMemory,
  upsertHoustonMemory,
  generateMinimizedHoustonSummary,
} = vi.hoisted(() => ({
  getHoustonMemorySettings: vi.fn(),
  inspectHoustonMemory: vi.fn(),
  upsertHoustonMemory: vi.fn(),
  generateMinimizedHoustonSummary: vi.fn(),
}));

vi.mock('@/lib/houston-memory/settings', () => ({ getHoustonMemorySettings }));
vi.mock('@/lib/houston-memory/service', () => ({ inspectHoustonMemory, upsertHoustonMemory }));
vi.mock('@/lib/houston-memory/summary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/houston-memory/summary')>();
  return { ...actual, generateMinimizedHoustonSummary };
});

const input = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  messages: [
    { role: 'user', text: 'Plan the release.' },
    { role: 'assistant', text: 'Use a staged rollout.' },
  ],
};

describe('Houston memory capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHoustonMemorySettings.mockResolvedValue({ enabled: true, retentionDays: 90 });
    inspectHoustonMemory.mockResolvedValue(null);
    generateMinimizedHoustonSummary.mockResolvedValue({
      title: 'Release planning',
      summary: 'Use a staged rollout.',
      decisions: [],
      commitments: [],
      topics: ['release'],
      linkedEntities: [],
    });
    upsertHoustonMemory.mockResolvedValue({ excludedAt: null });
  });

  it('uses the configured 90-day retention without persisting request messages', async () => {
    await expect(captureHoustonMemory(input)).resolves.toEqual({ status: 'captured' });

    expect(upsertHoustonMemory).toHaveBeenCalledOnce();
    const persisted = upsertHoustonMemory.mock.calls[0][0];
    expect(persisted).not.toHaveProperty('messages');
    expect(persisted).not.toHaveProperty('transcript');
    expect(
      new Date(persisted.retainUntil).getTime() - new Date(persisted.now).getTime(),
    ).toBe(90 * 24 * 60 * 60 * 1_000);
  });

  it('does no generation or egress when disabled or excluded', async () => {
    getHoustonMemorySettings.mockResolvedValueOnce({ enabled: false, retentionDays: 90 });
    await expect(captureHoustonMemory(input)).resolves.toEqual({
      status: 'skipped',
      reason: 'disabled',
    });
    expect(generateMinimizedHoustonSummary).not.toHaveBeenCalled();

    vi.clearAllMocks();
    getHoustonMemorySettings.mockResolvedValue({ enabled: true, retentionDays: 90 });
    inspectHoustonMemory.mockResolvedValueOnce({ excludedAt: '2026-03-01T00:00:00.000Z' });
    await expect(captureHoustonMemory(input)).resolves.toEqual({
      status: 'skipped',
      reason: 'excluded',
    });
    expect(generateMinimizedHoustonSummary).not.toHaveBeenCalled();
    expect(upsertHoustonMemory).not.toHaveBeenCalled();
  });

  it('does not write a memory when summary generation fails', async () => {
    generateMinimizedHoustonSummary.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(captureHoustonMemory(input)).rejects.toThrow('provider unavailable');
    expect(upsertHoustonMemory).not.toHaveBeenCalled();
  });

  it('does not revive a memory deleted while summary generation is in flight', async () => {
    upsertHoustonMemory.mockResolvedValueOnce({
      excludedAt: '2026-08-30T00:00:00.000Z',
    });

    await expect(captureHoustonMemory(input)).resolves.toEqual({
      status: 'skipped',
      reason: 'excluded',
    });
  });
});
