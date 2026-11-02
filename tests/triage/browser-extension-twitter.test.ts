import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const extensionDir = path.resolve(process.cwd(), 'clients/browser-extension');
const script = (file: string) => fs.readFileSync(path.join(extensionDir, file), 'utf8');
const bookmarksUrl = 'https://x.com/i/api/graphql/current-query/Bookmarks';
const tweet = (id: string) => ({
  __typename: 'Tweet', rest_id: id, legacy: { full_text: `Saved tweet ${id}` },
});
const end = { type: 'TimelineTerminateTimeline', direction: 'Bottom' };

function harness() {
  const window = new Window({ url: 'https://x.com/i/history' });
  window.document.cookie = 'twid=u%3D123';
  const sendMessage = vi.fn(async (message) => {
    if (message.type === 'mc-bulk-import-batch') {
      return { imported: message.items.length, skipped: 0, errors: [] };
    }
    return {};
  });
  const context = vm.createContext({
    window, document: window.document, CustomEvent: window.CustomEvent,
    chrome: { runtime: { sendMessage, onMessage: { addListener: vi.fn() }, getURL: (file: string) => file } },
    console, setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay), clearTimeout,
  });
  const fetch = vi.fn(async () => new window.Response(JSON.stringify({ entries: [tweet('10')] }), { status: 200 }));
  window.fetch = fetch;
  class Xhr extends window.EventTarget {
    responseType = '';
    responseText = JSON.stringify({ entries: [tweet('20')] });
    status = 200;
    open(method?: string, url?: string) { return { method, url }; }
    send() { this.dispatchEvent(new window.Event('load')); }
  }
  vm.runInContext(script('page-fetch-relay.js'), vm.createContext({
    window, XMLHttpRequest: Xhr, CustomEvent: window.CustomEvent, fetch, console,
  }));
  vm.runInContext(script('content-scripts/import/common.js'), context);
  vm.runInContext(script('content-scripts/import/twitter-import.js'), context);
  const observe = (entries: unknown[], options = {}) => window.dispatchEvent(new window.CustomEvent('mc-observed-response', {
    detail: { url: bookmarksUrl, status: 200, body: JSON.stringify({ entries }), ...options },
  }));
  return {
    window, context, sendMessage, Xhr, observe,
    run: () => vm.runInContext('startTwitterCapture()', context) as Promise<void>,
    batches: () => sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === 'mc-bulk-import-batch'),
    terminal: () => sendMessage.mock.calls.map(([message]) => message).findLast((message) => message.type === 'mc-import-progress' && message.done),
  };
}

afterEach(() => vi.useRealTimers());

describe('X saved-feed import', () => {
  it('captures fetch and XHR responses from before Import without injecting a late relay', async () => {
    const h = harness();
    await h.window.fetch(bookmarksUrl);
    await Promise.resolve();
    const xhr = new h.Xhr();
    xhr.open('GET', `${bookmarksUrl}?page=2`);
    xhr.send();
    const append = vi.spyOn(h.window.document.head, 'appendChild');
    vi.useFakeTimers();
    const run = h.run();
    await vi.advanceTimersByTimeAsync(12000);
    await run;
    expect(h.batches().flatMap((batch) => batch.items.map((item: { sourceId: string }) => item.sourceId))).toEqual(['twitter:10', 'twitter:20']);
    expect(append).not.toHaveBeenCalled();
    expect(h.terminal()).toMatchObject({ imported: 2, completed: false });
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ scope: '123:bookmarks' }));
  });

  it('captures already-rendered tweets and automatically loads older ones', async () => {
    const h = harness();
    h.window.document.body.innerHTML = '<article data-testid="tweet"><a href="/alice/status/30"><time datetime="2026-11-01"></time></a><div data-testid="tweetText">Visible saved tweet</div></article>';
    vi.spyOn(h.window.document.documentElement, 'scrollHeight', 'get').mockReturnValue(2000);
    const scroll = vi.spyOn(h.window, 'scrollTo').mockImplementation((options) => {
      if (typeof options === 'object' && options.top !== 0) h.observe([tweet('40'), end]);
    });
    vi.useFakeTimers();
    const run = h.run();
    await vi.advanceTimersByTimeAsync(2500);
    await run;
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(scroll.mock.calls.length).toBeGreaterThan(1);
    expect(h.batches().flatMap((batch) => batch.items.map((item: { sourceId: string }) => item.sourceId))).toEqual(['twitter:30', 'twitter:40']);
    expect(h.terminal()).toMatchObject({ imported: 2, completed: true, errors: [] });
  });

  it('does not treat a buffered end-of-feed response as proof of full history', async () => {
    const h = harness();
    vi.useFakeTimers();
    const run = h.run();
    h.observe([tweet('50'), end], { buffered: true });
    await vi.advanceTimersByTimeAsync(12000);
    await run;
    expect(h.terminal()).toMatchObject({ imported: 1, completed: false });
  });

  it('reports an empty stalled feed as an error, not a successful zero-item import', async () => {
    const h = harness();
    vi.useFakeTimers();
    const run = h.run();
    await vi.advanceTimersByTimeAsync(12000);
    await run;
    expect(h.terminal()).toMatchObject({ imported: 0, completed: false, errors: [expect.stringContaining('No saved tweets')] });
  });

  it('reports X request failures and preserves a partial-history result', async () => {
    const h = harness();
    vi.useFakeTimers();
    const run = h.run();
    h.observe([], { status: 429 });
    await vi.advanceTimersByTimeAsync(1500);
    await run;
    expect(h.terminal()).toMatchObject({ completed: false, errors: [expect.stringContaining('429')] });
  });

  it('finishes early, removes the observer, and permits another import', async () => {
    const h = harness();
    vi.useFakeTimers();
    const first = h.run();
    const finish = vm.runInContext('finishTwitterCapture()', h.context) as Promise<void>;
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([first, finish]);
    expect(h.terminal()).toMatchObject({ completed: false, errors: [] });
    h.observe([tweet('70')]);
    expect(h.batches()).toHaveLength(0);

    const second = h.run();
    h.observe([tweet('71'), end]);
    await vi.advanceTimersByTimeAsync(1500);
    await second;
    expect(h.terminal()).toMatchObject({ imported: 1, completed: true });
  });

  it('stops automatically when the selected saved feed changes', async () => {
    const h = harness();
    vi.useFakeTimers();
    const run = h.run();
    h.window.document.body.innerHTML = '<button role="tab" aria-selected="true">Likes</button>';
    await vi.advanceTimersByTimeAsync(1500);
    await run;
    expect(h.terminal()).toMatchObject({ completed: false, errors: [expect.stringContaining('saved feed changed')] });
  });

  it('does not import quoted tweets as separate bookmarks and preserves long-form text', () => {
    const h = harness();
    const parent = { ...tweet('60'), quoted_status_result: { result: tweet('61') }, note_tweet: { note_tweet_results: { result: { text: 'Full note text' } } } };
    h.context.body = JSON.stringify({ result: parent });
    const results = vm.runInContext('extractTweets(body).map((value) => normalizeTweet(value, "bookmarks"))', h.context);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourceId: 'twitter:60', description: 'Full note text' });
  });
});
