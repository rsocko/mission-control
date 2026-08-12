import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getWordInsights } = vi.hoisted(() => ({
  getWordInsights: vi.fn(),
}));

vi.mock('@/lib/word-insights/service', () => ({
  getWordInsights,
}));

beforeEach(() => {
  getWordInsights.mockReset();
  getWordInsights.mockResolvedValue({
    words: [],
    tasks: [],
    enabledSources: [],
    analyzedTaskCount: 0,
    truncated: false,
    totalWordCount: 0,
    wordTruncated: false,
    limits: {},
  });
});

describe('GET /api/word-insights', () => {
  it('passes validated source toggles and clamped limits to the service', async () => {
    const { GET } = await import('@/app/api/word-insights/route');
    const response = await GET(new Request(
      'http://localhost/api/word-insights?sources=title,tag,unknown&taskLimit=99999&wordLimit=0',
    ));

    expect(response.status).toBe(200);
    expect(getWordInsights).toHaveBeenCalledWith({
      enabledSources: ['title', 'tag'],
      taskLimit: 1_000,
      wordLimit: 1,
    });
  });

  it('supports disabling every source explicitly', async () => {
    const { GET } = await import('@/app/api/word-insights/route');
    await GET(new Request('http://localhost/api/word-insights?sources='));

    expect(getWordInsights).toHaveBeenCalledWith(expect.objectContaining({
      enabledSources: [],
    }));
  });

  it('uses deterministic defaults when query values are absent or invalid', async () => {
    const { GET } = await import('@/app/api/word-insights/route');
    await GET(new Request('http://localhost/api/word-insights?taskLimit=nope'));

    expect(getWordInsights).toHaveBeenCalledWith({
      enabledSources: undefined,
      taskLimit: 500,
      wordLimit: 50,
    });
  });
});
