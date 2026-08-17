import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

const commonScript = fs.readFileSync(
  path.resolve(process.cwd(), 'clients/browser-extension/content-scripts/import/common.js'),
  'utf8',
);
const popupScript = fs.readFileSync(
  path.resolve(process.cwd(), 'clients/browser-extension/popup.js'),
  'utf8',
);

type ImportProgressListener = (message: {
  type: string;
  platform: string;
  imported: number;
  skipped: number;
  errors: string[];
  done: boolean;
}) => void;

describe('browser extension imports', () => {
  it('waits for the page relay to load before dispatching the first fetch', async () => {
    const window = new Window({ url: 'https://www.instagram.com/test/saved/all-posts/' });
    const appendRelay = vi.spyOn(window.document.head, 'appendChild')
      .mockImplementation((node) => node);
    const requestListener = vi.fn((event: Event) => {
      const detail = (event as CustomEvent).detail;
      window.dispatchEvent(new window.CustomEvent('mc-fetch-response', {
        detail: { id: detail.id, status: 200, ok: true, body: '{"items":[]}' },
      }));
    });
    window.addEventListener('mc-fetch-request', requestListener);

    const context = vm.createContext({
      window,
      document: window.document,
      chrome: {
        runtime: {
          getURL: (file: string) => `chrome-extension://test/${file}`,
          sendMessage: vi.fn(),
        },
      },
      CustomEvent: window.CustomEvent,
      console,
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(commonScript, context);

    const importCommon = (window as unknown as {
      MCImportCommon: {
        relayFetch: (url: string, options: RequestInit) => Promise<{
          ok: boolean;
          status: number;
        }>;
      };
    }).MCImportCommon;
    const fetchPromise = importCommon.relayFetch(
      'https://www.instagram.com/api/v1/feed/saved/posts/',
      { method: 'GET' },
    );

    expect(requestListener).not.toHaveBeenCalled();
    const relayScript = appendRelay.mock.calls[0]?.[0] as HTMLScriptElement | undefined;
    expect(relayScript?.src).toBe('chrome-extension://test/page-fetch-relay.js');

    relayScript?.dispatchEvent(new window.Event('load'));
    await expect(fetchPromise).resolves.toMatchObject({ ok: true, status: 200 });
    expect(requestListener).toHaveBeenCalledOnce();
  });

  it('shows terminal import errors instead of reporting a successful empty import', async () => {
    const window = new Window({ url: 'chrome-extension://test/popup.html' });
    window.document.body.innerHTML = `
      <div id="setup"></div>
      <div id="main"></div>
      <input id="apiUrl" />
      <input id="captureKey" />
      <div id="configError"></div>
      <button id="saveConfig"></button>
      <button id="settingsBtn"></button>
      <button id="openMcBtn"></button>
      <div id="dynamicContent"></div>
    `;

    let progressListener: ImportProgressListener | undefined;
    const chrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener) => {
            progressListener = listener;
          }),
        },
      },
      storage: {
        sync: {
          get: vi.fn(async () => ({ apiUrl: 'http://localhost:3099', captureKey: 'test-key' })),
          set: vi.fn(),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(),
          remove: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn(async () => [{
          id: 1,
          title: 'Saved posts',
          url: 'https://www.instagram.com/test/saved/all-posts/',
        }]),
        create: vi.fn(),
        update: vi.fn(),
        sendMessage: vi.fn(),
      },
    };
    const context = vm.createContext({
      window,
      document: window.document,
      chrome,
      URL: window.URL,
      URLSearchParams: window.URLSearchParams,
      console,
      fetch: vi.fn(),
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(popupScript, context);
    await vi.waitFor(() => expect(window.document.getElementById('importStatus')).not.toBeNull());

    expect(progressListener).toBeDefined();
    progressListener?.({
      type: 'mc-import-progress',
      platform: 'instagram',
      imported: 0,
      skipped: 0,
      errors: ['Relay fetch timed out'],
      done: true,
    });

    const status = window.document.getElementById('importStatus');
    expect(status?.textContent).toContain('Finished with errors');
    expect(status?.textContent).toContain('Relay fetch timed out');
    expect(status?.className).toBe('import-status error');
  });
});
