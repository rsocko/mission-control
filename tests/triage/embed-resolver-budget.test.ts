import { describe, expect, it, vi } from 'vitest';
import { INGESTION_LIMITS } from '@/lib/ingestion/bounded-reader';
vi.mock('metascraper', () => ({ default: () => vi.fn() }));
vi.mock('metascraper-title', () => ({ default: () => ({}) }));
vi.mock('metascraper-description', () => ({ default: () => ({}) }));
vi.mock('metascraper-image', () => ({ default: () => ({}) }));
vi.mock('metascraper-video', () => ({ default: () => ({}) }));
vi.mock('metascraper-url', () => ({ default: () => ({}) }));
vi.mock('metascraper-logo', () => ({ default: () => ({}) }));
vi.mock('metascraper-author', () => ({ default: () => ({}) }));
vi.mock('metascraper-publisher', () => ({ default: () => ({}) }));
vi.mock('metascraper-iframe', () => ({ default: () => ({}) }));

describe('embed resolver ingestion budget', () => {
  it('enforces the embed-specific HTML limit before metadata parsing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('x', {
      headers: {
        'content-length': String(INGESTION_LIMITS.embedHtmlBytes + 1),
        'content-type': 'text/html',
      },
    }));
    const { resolveEmbed } = await import('@/lib/triage/embed-resolver');

    await expect(resolveEmbed('https://93.184.216.34/article')).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(`${INGESTION_LIMITS.embedHtmlBytes}-byte limit`),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
  });
});
