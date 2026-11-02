import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { HTMLButtonElement, Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

const extensionDir = path.resolve(process.cwd(), 'clients/browser-extension');
const commonScript = fs.readFileSync(path.join(extensionDir, 'content-scripts/import/common.js'), 'utf8');

type Item = { sourceId: string; sourceUrl: string };
type Checkpoint = {
  seenIds: string[];
  completed: boolean;
  newestId?: string;
  resumeCursor?: number | null;
  earliestItem?: Item;
  lastImportedAt?: string;
};
type Result = { imported: number; skipped: number; errors: string[]; completed: boolean };
type Common = {
  runPagedImport: (options: {
    platform: string;
    scope?: string;
    maxPages: number;
    initialCursor: number;
    ordered?: boolean;
    fetchPage: (cursor: number) => Promise<{ items: Item[]; nextCursor: number | null }>;
  }) => Promise<Result>;
  collectPages: (options: {
    maxPages: number;
    initialCursor: number;
    fetchPage: (cursor: number) => Promise<{ items: Item[]; nextCursor: number | null }>;
  }) => Promise<Item[]>;
};

function item(id: string): Item {
  return { sourceId: id, sourceUrl: `https://example.com/${id}` };
}

function loadCommon(
  histories = new Map<string, Checkpoint>(),
  batchResult = (items: Item[]) => ({ imported: items.length, skipped: 0, errors: [] as string[] }),
) {
  const window = new Window({ url: 'https://www.reddit.com/user/test/saved' });
  let failId: string | null = null;
  let storageError = false;
  const batches: Item[][] = [];
  const sendMessage = vi.fn(async (message) => {
    if (message.type === 'mc-get-import-checkpoint') {
      return { checkpoint: structuredClone(histories.get(message.scope) || null) };
    }
    if (message.type === 'mc-save-import-checkpoint') {
      if (storageError) return { error: 'Local storage unavailable' };
      histories.set(message.scope, structuredClone(message.checkpoint));
      return {};
    }
    if (message.type === 'mc-bulk-import-batch') {
      batches.push(message.items);
      if (message.items.some((entry: Item) => entry.sourceId === failId)) {
        return { imported: 0, skipped: 0, errors: ['Server rejected batch'] };
      }
      return batchResult(message.items);
    }
    return {};
  });
  vm.runInContext(commonScript, vm.createContext({
    window, document: window.document, chrome: { runtime: { sendMessage } },
    console, setTimeout, clearTimeout,
  }));
  return {
    common: (window as unknown as { MCImportCommon: Common }).MCImportCommon,
    histories, batches, sendMessage,
    fail: (id: string | null) => { failId = id; },
    failStorage: () => { storageError = true; },
  };
}

function options(fetchPage: (cursor: number) => Promise<{ items: Item[]; nextCursor: number | null }>, maxPages = 50) {
  return { platform: 'reddit', scope: 'test/saved', maxPages, initialCursor: 0, fetchPage };
}

describe('browser-local import checkpoints', () => {
  it('continues past 99 local duplicates and an acknowledged refresh into unfinished Reddit history', async () => {
    const known = Array.from({ length: 99 }, (_, index) => item(`known-${index}`));
    const harness = loadCommon(new Map([['test/saved', {
      seenIds: known.map((entry) => entry.sourceId), completed: false,
    }]]), (items) => items[0].sourceId === 'refreshed'
      ? { imported: 0, skipped: 1, errors: [] }
      : { imported: items.length, skipped: 0, errors: [] });
    const fetchPage = vi.fn(async (cursor: number) => cursor === 0
      ? { items: [item('refreshed'), ...known], nextCursor: 1 }
      : { items: [item('oldest')], nextCursor: null });
    expect(await harness.common.runPagedImport(options(fetchPage))).toMatchObject({
      imported: 1, skipped: 100, completed: true, errors: [],
    });
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([0, 1]);
    expect(harness.histories.get('test/saved')?.seenIds).toContain('refreshed');
  });

  it('resolves Reddit /user/me to the actual account instead of sharing an account-agnostic checkpoint', async () => {
    const window = new Window({ url: 'https://www.reddit.com/user/me/saved' });
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ name: 'actual-account' }) }));
    const context = vm.createContext({
      window, document: window.document, fetch, chrome: { runtime: { onMessage: { addListener: vi.fn() } } },
    });
    vm.runInContext(fs.readFileSync(path.join(extensionDir, 'content-scripts/import/reddit-import.js'), 'utf8'), context);
    expect(await vm.runInContext('extractRedditUsername()', context)).toBe('actual-account');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses Instagram account IDs and separates its collections', async () => {
    const window = new Window({ url: 'https://www.instagram.com/example/saved/collection/123/' });
    window.document.cookie = 'csrftoken=test-token';
    window.document.cookie = 'ds_user_id=456';
    window.document.body.innerHTML = '<script>{"X-IG-App-ID":"789"}</script>';
    const runPagedImport = vi.fn(async () => ({}));
    Object.assign(window, { MCImportCommon: { runPagedImport } });
    const context = vm.createContext({
      window, document: window.document, chrome: { runtime: { onMessage: { addListener: vi.fn() } } },
    });
    vm.runInContext(fs.readFileSync(path.join(extensionDir, 'content-scripts/import/instagram-import.js'), 'utf8'), context);
    await vm.runInContext('runInstagramImport()', context);
    expect(runPagedImport).toHaveBeenCalledWith(expect.objectContaining({ scope: '456/saved/123' }));
  });

  it('checks new items then jumps to the unfinished tail after restarting the content script', async () => {
    const first = loadCommon();
    await first.common.runPagedImport(options(async () => ({
      items: [item('a'), item('b')], nextCursor: 10,
    }), 1));
    expect(first.histories.get('test/saved')).toMatchObject({
      seenIds: ['a', 'b'], completed: false, newestId: 'a', resumeCursor: 10,
    });

    const second = loadCommon(first.histories);
    const fetchPage = vi.fn(async (cursor: number) => cursor === 0
      ? { items: [item('new'), item('a'), item('b')], nextCursor: 2 }
      : { items: [item('oldest')], nextCursor: null });
    const result = await second.common.runPagedImport(options(fetchPage));
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([0, 10]);
    expect(second.batches.flat().map((entry) => entry.sourceId)).toEqual(['new', 'oldest']);
    expect(result).toMatchObject({ completed: true, imported: 2, errors: [] });
    expect(second.histories.get('test/saved')?.earliestItem?.sourceId).toBe('oldest');
  });

  it('stops at the saved boundary only after full history was confirmed', async () => {
    const harness = loadCommon(new Map([['test/saved', {
      seenIds: ['a', 'old'], completed: true, newestId: 'a',
      earliestItem: item('old'),
    }]]));
    const fetchPage = vi.fn(async () => ({
      items: [item('new'), item('a'), item('old')], nextCursor: 10,
    }));
    expect(await harness.common.runPagedImport(options(fetchPage))).toMatchObject({ imported: 1, completed: true });
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(harness.histories.get('test/saved')?.earliestItem?.sourceId).toBe('old');
  });

  it('does not move the boundary past a failed new-head batch or skip its gap on retry', async () => {
    const harness = loadCommon(new Map([['test/saved', {
      seenIds: ['a'], completed: false, newestId: 'a', resumeCursor: 10,
    }]]));
    harness.fail('gap');
    const fetchPage = vi.fn(async (cursor: number) => {
      if (cursor === 0) return { items: [item('new')], nextCursor: 1 };
      if (cursor === 1) return { items: [item('gap')], nextCursor: 2 };
      if (cursor === 2) return { items: [item('a')], nextCursor: 3 };
      return { items: [item('older')], nextCursor: null };
    });
    expect(await harness.common.runPagedImport(options(fetchPage))).toMatchObject({ completed: false, errors: ['Server rejected batch'] });
    expect(harness.histories.get('test/saved')?.newestId).toBe('a');
    expect(harness.histories.get('test/saved')?.resumeCursor).toBe(10);
    harness.fail(null);
    fetchPage.mockClear();
    expect(await harness.common.runPagedImport(options(fetchPage))).toMatchObject({ completed: true });
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([0, 1, 2, 10]);
    expect(harness.histories.get('test/saved')?.seenIds).toContain('gap');
  });

  it('recovers a deleted boundary by checkpointing the fully scanned prefix at the page limit', async () => {
    const harness = loadCommon(new Map([['test/saved', {
      seenIds: ['deleted'], completed: false, newestId: 'deleted', resumeCursor: 100,
    }]]));
    await harness.common.runPagedImport(options(async () => ({ items: [item('new')], nextCursor: 1 }), 1));
    expect(harness.histories.get('test/saved')).toMatchObject({ newestId: 'new', resumeCursor: 1, completed: false });
  });

  it('keeps account and collection histories separate and scans unordered lists to their real end', async () => {
    const harness = loadCommon(new Map([['test/saved', { seenIds: ['a'], completed: true, newestId: 'a' }]]));
    const fetchPage = vi.fn(async (cursor: number) => ({
      items: [item(cursor === 0 ? 'a' : 'b')], nextCursor: cursor === 0 ? 1 : null,
    }));
    expect(await harness.common.runPagedImport({ ...options(fetchPage), ordered: false })).toMatchObject({ imported: 1, skipped: 1 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(await harness.common.runPagedImport({ ...options(fetchPage), scope: 'another/saved' })).toMatchObject({ imported: 2 });
  });

  it('never claims completion when pagination fails or a discovery list hits its limit', async () => {
    const harness = loadCommon();
    expect(await harness.common.runPagedImport(options(async () => { throw new Error('Cursor expired'); }))).toMatchObject({
      completed: false, errors: ['Cursor expired'],
    });
    await expect(harness.common.collectPages({
      maxPages: 1, initialCursor: 0,
      fetchPage: async () => ({ items: [], nextCursor: 1 }),
    })).rejects.toThrow('page limit');
  });

  it('surfaces checkpoint write failures and repeated pagination cursors as incomplete', async () => {
    const harness = loadCommon();
    harness.failStorage();
    expect(await harness.common.runPagedImport(options(async () => ({ items: [item('a')], nextCursor: null })))).toMatchObject({
      completed: false, errors: ['Local storage unavailable'],
    });
    expect(harness.histories.size).toBe(0);
    const repeated = loadCommon();
    expect(await repeated.common.runPagedImport(options(async () => ({ items: [], nextCursor: 0 })))).toMatchObject({
      completed: false, errors: [expect.stringContaining('cursor did not advance')],
    });
  });
});

function storageArea(data: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string | string[] | null) => key === null
      ? { ...data }
      : Object.fromEntries((Array.isArray(key) ? key : [key]).map((entry) => [entry, data[entry]]))),
    set: vi.fn(async (patch: Record<string, unknown>) => { Object.assign(data, patch); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
  };
}

function loadBackground() {
  type Message = Record<string, unknown>;
  type Listener = (message: Message, sender: { tab?: { id: number } }, respond: (value: Message) => void) => boolean;
  let listener: Listener;
  let onRemoved: (tabId: number) => void;
  let onUpdated: (tabId: number, change: { status: string }) => void;
  const session: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const config: Record<string, unknown> = { apiUrl: 'https://mc.example.com' };
  const chrome = {
    runtime: {
      onMessage: { addListener: (value: Listener) => { listener = value; } },
      onInstalled: { addListener: vi.fn() },
    },
    storage: { session: storageArea(session), local: storageArea(local), sync: storageArea(config) },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: 'https://www.reddit.com/user/test/saved' })),
      sendMessage: vi.fn(async () => ({ started: true })),
      onRemoved: { addListener: (value: typeof onRemoved) => { onRemoved = value; } },
      onUpdated: { addListener: (value: typeof onUpdated) => { onUpdated = value; } },
    },
    alarms: { onAlarm: { addListener: vi.fn() } },
    commands: { onCommand: { addListener: vi.fn() } },
    contextMenus: { onClicked: { addListener: vi.fn() } },
  };
  vm.runInContext(fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8'), vm.createContext({
    chrome, importScripts: vi.fn(), crypto: { randomUUID: () => crypto.randomUUID() }, console,
  }));
  return {
    session, local, config, chrome,
    send: (message: Message, tabId?: number) => new Promise<Message>((resolve) => {
      listener(message, tabId == null ? {} : { tab: { id: tabId } }, resolve);
    }),
    remove: (tabId: number) => onRemoved(tabId),
    reload: (tabId: number) => onUpdated(tabId, { status: 'loading' }),
  };
}

describe('background import ownership', () => {
  it('replaces legacy ownerless state and unlocks a failed page launch', async () => {
    const harness = loadBackground();
    harness.session.importState_reddit = { imported: 4, done: false };
    harness.chrome.tabs.sendMessage.mockRejectedValueOnce(new Error('Page unavailable'));
    expect((await harness.send({ type: 'mc-request-import', platform: 'reddit', tabId: 1 })).error).toBe('Page unavailable');
    expect(harness.session.importState_reddit).toMatchObject({ done: true });
    expect(await harness.send({ type: 'mc-request-import', platform: 'reddit', tabId: 1 })).toEqual({ started: true });
  });
  it('allows different sources concurrently but rejects simultaneous launches of the same source', async () => {
    const harness = loadBackground();
    const results = await Promise.all([
      harness.send({ type: 'mc-request-import', platform: 'reddit', tabId: 1 }),
      harness.send({ type: 'mc-request-import', platform: 'reddit', tabId: 2 }),
      harness.send({ type: 'mc-request-import', platform: 'instagram', tabId: 3 }),
    ]);
    expect(results[0]).toEqual({ started: true });
    expect(results[1].error).toContain('already importing');
    expect(results[2]).toEqual({ started: true });
    expect(harness.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  describe('background bulk-import relay', () => {
    it('only sends batches belonging to the current run and configured destination', async () => {
      type Listener = (message: Record<string, unknown>, sender: { tab: { id: number } }, respond: (value: Record<string, unknown>) => void) => boolean;
      let listener: Listener;
      const session = { importState_reddit: { tabId: 1, runId: 'current', done: false, apiUrl: 'https://mc.example.com' } };
      const config = { apiUrl: 'https://mc.example.com', captureKey: 'test-key' };
      const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ imported: 0, skipped: 0, refreshed: 1, errors: [] }) }));
      vm.runInContext(fs.readFileSync(path.join(extensionDir, 'background/bulk-import.js'), 'utf8'), vm.createContext({
        chrome: {
          storage: { session: storageArea(session), sync: storageArea(config) },
          runtime: { onMessage: { addListener: (value: Listener) => { listener = value; } } },
        },
        fetch, console,
      }));
      const send = (runId: string, tabId = 1) => new Promise<Record<string, unknown>>((resolve) => {
        listener({ type: 'mc-bulk-import-batch', platform: 'reddit', runId, items: [item('a')] }, { tab: { id: tabId } }, resolve);
      });
      expect((await send('old')).error).toContain('no longer active');
      expect((await send('current', 2)).error).toContain('no longer active');
      expect(fetch).not.toHaveBeenCalled();
      expect(await send('current')).toEqual({ imported: 0, skipped: 1, errors: [] });
      expect(fetch).toHaveBeenCalledOnce();
      config.apiUrl = 'https://other.example.com';
      expect((await send('current')).error).toContain('settings changed');
      expect(fetch).toHaveBeenCalledOnce();
    });
  });

  async function loadPopup(url: string, session: Record<string, unknown> = {}) {
    const window = new Window({ url: 'chrome-extension://test/popup.html' });
    window.document.write(fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8'));
    let progress: (message: Record<string, unknown>, sender?: { tab: { id: number } }) => void = () => {};
    const chrome = {
      runtime: {
        onMessage: { addListener: (listener: typeof progress) => { progress = listener; } },
        sendMessage: vi.fn(async () => ({ started: true })),
      },
      storage: {
        sync: storageArea({ apiUrl: 'https://mc.example.com', captureKey: 'test-key' }),
        session: storageArea(session),
        local: storageArea({}),
      },
      tabs: {
        query: vi.fn(async () => [{ id: 1, windowId: 1, url, title: 'Saved items' }]),
        update: vi.fn(async () => ({ windowId: 1 })),
        create: vi.fn(),
        sendMessage: vi.fn(async () => ({ stopped: true })),
      },
      windows: { update: vi.fn() },
    };
    const context = vm.createContext({
      window, document: window.document, chrome, URL: window.URL, URLSearchParams: window.URLSearchParams,
      console, fetch: vi.fn(), setTimeout, clearTimeout,
    });
    for (const file of ['shared/capture-client.js', 'popup/dom.js', 'popup/capture.js', 'popup/send-tabs.js', 'popup.js']) {
      vm.runInContext(fs.readFileSync(path.join(extensionDir, file), 'utf8'), context);
    }
    await vi.waitFor(() => expect(window.document.getElementById('importBtn')).not.toBeNull());
    await vi.waitFor(() => expect(chrome.storage.session.get).toHaveBeenCalledWith(null));
    return { window, chrome, progress: (message: Record<string, unknown>, tabId?: number) => progress(message, tabId == null ? undefined : { tab: { id: tabId } }) };
  }

  describe('extension import context UI', () => {
    it.each(['https://x.com/i/history', 'https://x.com/i/bookmarks', 'https://twitter.com/alice/likes?tab=all'])('recognizes the X saved route %s', async (url) => {
      const { window } = await loadPopup(url);
      expect(window.document.getElementById('importBtn')?.textContent).toBe('Import Saved Items');
      expect(window.document.getElementById('importBanner')?.getAttribute('data-needs-redirect')).toBe('false');
    });

    it('keeps other-source progress out of the visible card and labels its originating tab', async () => {
      const harness = await loadPopup('https://x.com/i/history', {
        importState_instagram: { tabId: 2, imported: 13, skipped: 603, done: false },
      });
      await vi.waitFor(() => expect(harness.window.document.getElementById('activeImports')?.textContent).toContain('Instagram: 13 imported, 603 skipped in another tab'));
      harness.progress({ type: 'mc-import-progress', platform: 'instagram', imported: 20, done: false }, 2);
      expect(harness.window.document.getElementById('importBtn')?.textContent).toBe('Import Saved Items');
      expect(harness.window.document.getElementById('importStatus')?.textContent).toBe('');
      harness.window.document.querySelector<HTMLButtonElement>('#activeImports button')?.click();
      await vi.waitFor(() => expect(harness.chrome.tabs.update).toHaveBeenCalledWith(2, { active: true }));
    });

    it('restores an active capture after reopening and finishes its original tab even after SPA navigation', async () => {
      const harness = await loadPopup('https://x.com/home', {
        importState_twitter: { tabId: 1, imported: 4, skipped: 2, done: false, live: true },
      });
      await vi.waitFor(() => expect(harness.window.document.getElementById('importBtn')?.textContent).toBe('Finish'));
      harness.window.document.querySelector<HTMLButtonElement>('#importBtn')?.click();
      await vi.waitFor(() => expect(harness.chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'mc-stop-import', platform: 'twitter' }));
      expect(harness.chrome.tabs.update).not.toHaveBeenCalled();
    });

    it('disables a second same-source import and does not turn its button into Finish', async () => {
      const harness = await loadPopup('https://x.com/i/history', {
        importState_twitter: { tabId: 2, imported: 4, done: false, live: true },
      });
      await vi.waitFor(() => expect(harness.window.document.querySelector<HTMLButtonElement>('#importBtn')?.disabled).toBe(true));
      expect(harness.window.document.getElementById('importBtn')?.textContent).toBe('Import Saved Items');
      expect(harness.window.document.getElementById('importStatus')?.textContent).toContain('another tab');
    });
  });

  it('rejects progress from other tabs and old runs, persists checkpoints by destination, and unlocks closed tabs', async () => {
    const harness = loadBackground();
    await harness.send({ type: 'mc-request-import', platform: 'reddit', tabId: 1 });
    const state = harness.session.importState_reddit as { runId: string };
    const progress = { type: 'mc-import-progress', platform: 'reddit', runId: state.runId, imported: 4 };
    expect((await harness.send(progress, 2)).error).toBeDefined();
    expect((await harness.send({ ...progress, runId: 'old' }, 1)).error).toBeDefined();
    await harness.send(progress, 1);
    expect(harness.session.importState_reddit).toMatchObject({ imported: 4, tabId: 1 });
    const checkpoint = { seenIds: ['a'], completed: false };
    await harness.send({ type: 'mc-save-import-checkpoint', platform: 'reddit', runId: state.runId, scope: 'test/saved', checkpoint }, 1);
    expect(await harness.send({ type: 'mc-get-import-checkpoint', platform: 'reddit', runId: state.runId, scope: 'test/saved' }, 1)).toEqual({ checkpoint });
    harness.config.apiUrl = 'https://different.example.com';
    expect((await harness.send({ type: 'mc-get-import-checkpoint', platform: 'reddit', runId: state.runId, scope: 'test/saved' }, 1)).error).toContain('settings changed');
    await harness.send({ ...progress, done: true }, 1);
    await harness.send({ type: 'mc-request-import', platform: 'reddit', tabId: 1 });
    const newState = harness.session.importState_reddit as { runId: string };
    expect(await harness.send({ type: 'mc-get-import-checkpoint', platform: 'reddit', runId: newState.runId, scope: 'test/saved' }, 1)).toEqual({ checkpoint: null });
    harness.remove(1);
    await harness.send({ type: 'mc-request-import', platform: 'reddit', tabId: 2 });
    expect(harness.session.importState_reddit).toMatchObject({ tabId: 2, done: false });
  });

  it('marks reloads interrupted and permits resetting local checkpoints only when idle', async () => {
    const harness = loadBackground();
    await harness.send({ type: 'mc-request-import', platform: 'reddit', tabId: 1 });
    expect((await harness.send({ type: 'mc-reset-import-history', platform: 'reddit' })).error).toContain('Finish');
    harness.reload(1);
    await harness.send({ type: 'mc-reset-import-history', platform: 'reddit' });
    expect(harness.session.importState_reddit).toMatchObject({ done: true, error: expect.stringContaining('interrupted') });
    expect(harness.chrome.storage.local.remove).toHaveBeenCalled();
  });
});
