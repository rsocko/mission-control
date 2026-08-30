import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/houston-memory/capture', () => ({
  captureHoustonMemory: mocks.capture,
}));
vi.mock('@/lib/houston-memory/request-auth', () => ({
  isTrustedHoustonMemoryRequest: () => true,
}));
vi.mock('@/lib/houston-memory/settings', () => ({
  getHoustonMemorySettings: vi.fn(),
}));
vi.mock('@/lib/houston-memory/service', () => ({
  listHoustonMemories: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  aiLogger: { warn: mocks.warn },
}));

describe('Houston memory API privacy', () => {
  beforeEach(() => {
    mocks.capture.mockReset();
    mocks.warn.mockReset();
  });

  it('does not serialize provider errors that may contain raw request messages', async () => {
    const providerError = Object.assign(new Error('provider failed'), {
      requestBodyValues: { prompt: 'raw private conversation' },
    });
    mocks.capture.mockRejectedValue(providerError);
    const { POST } = await import('@/app/api/ai/memories/route');

    const response = await POST(new Request('http://localhost/api/ai/memories', {
      method: 'POST',
      body: '{}',
    }));

    expect(response.status).toBe(503);
    expect(mocks.warn).toHaveBeenCalledWith(
      { event: 'houston_memory_capture_failed' },
      'Houston memory capture failed',
    );
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('raw private conversation');
  });
});
