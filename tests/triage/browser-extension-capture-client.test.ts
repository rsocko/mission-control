import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

const captureClientScript = fs.readFileSync(
  path.resolve(process.cwd(), 'clients/browser-extension/shared/capture-client.js'),
  'utf8',
);
const backgroundScript = fs.readFileSync(
  path.resolve(process.cwd(), 'clients/browser-extension/background.js'),
  'utf8',
);
const popupCaptureScript = fs.readFileSync(
  path.resolve(process.cwd(), 'clients/browser-extension/popup/capture.js'),
  'utf8',
);

function loadClient(pageMeta: Record<string, unknown> = {}) {
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ item: { id: 'captured' } }),
  }));
  const context = vm.createContext({
    chrome: {
      storage: {
        sync: {
          get: vi.fn(async () => ({ apiUrl: 'http://localhost:3099', captureKey: 'secret' })),
        },
      },
      tabs: {
        sendMessage: vi.fn(async () => pageMeta),
      },
    },
    fetch,
    URL,
  });
  vm.runInContext(captureClientScript, context);
  return {
    client: (context as unknown as {
      MCCapture: {
        capture: (input: Record<string, unknown>) => Promise<{ payload: Record<string, unknown> }>;
        isInternalUrl: (url?: string) => boolean;
      };
    }).MCCapture,
    fetch,
  };
}

describe('browser extension capture client', () => {
  it('routes popup, shortcut, and context-menu captures through the shared client', () => {
    expect(backgroundScript).toContain('await MCCapture.capture({ url, title, description, tabId })');
    expect(popupCaptureScript).toContain('await MCCapture.capture({');
    expect(backgroundScript).not.toContain('/api/triage/capture');
    expect(popupCaptureScript).not.toContain('/api/triage/capture');
  });

  it('uses one canonical guard for internal and non-web URLs', () => {
    const { client } = loadClient();

    for (const url of [
      undefined,
      'chrome://settings',
      'chrome-extension://test/popup.html',
      'edge://favorites',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'file:///tmp/example.html',
      'not a url',
    ]) {
      expect(client.isInternalUrl(url)).toBe(true);
    }
    expect(client.isInternalUrl('https://example.com/article')).toBe(false);
    expect(client.isInternalUrl('http://localhost:3099')).toBe(false);
  });

  it('builds the same rich payload for every capture entry point', async () => {
    const { client, fetch } = loadClient({
      ogTitle: 'Open Graph title',
      twitterTitle: 'Twitter title',
      ogDescription: 'Open Graph description',
      thumbnailUrl: 'https://example.com/preferred.jpg',
      ogImage: 'https://example.com/og.jpg',
      detectedPlatform: 'reddit',
      platformMeta: { subreddit: 'testing', thumbnailUrl: 'https://example.com/meta.jpg' },
    });

    const result = await client.capture({
      url: 'https://example.com/article',
      title: 'Tab title',
      description: 'User note',
      tabId: 7,
    });

    expect(result.payload).toEqual({
      url: 'https://example.com/article',
      title: 'Open Graph title',
      description: 'User note',
      thumbnailUrl: 'https://example.com/preferred.jpg',
      client: 'browser',
      sourcePlatform: 'reddit',
      platformMeta: { subreddit: 'testing', thumbnailUrl: 'https://example.com/meta.jpg' },
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(result.payload);
  });

  it('rejects internal URLs before reading configuration or fetching', async () => {
    const { client, fetch } = loadClient();

    await expect(client.capture({ url: 'devtools://devtools' })).rejects.toMatchObject({
      code: 'INTERNAL_URL',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
