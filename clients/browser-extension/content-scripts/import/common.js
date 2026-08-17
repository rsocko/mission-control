// import-common.js — shared helpers for the platform bulk-import content
// scripts (Reddit / Instagram / Facebook / TikTok / Pinterest / Twitter).
// Loaded before each platform's script so it can rely on
// window.MCImportCommon being defined.
//
// Provides:
//   - relayFetch(url, options): fetch through the MAIN-world page-fetch-relay
//     so requests carry the page's own session cookies/CSRF context. Needed
//     for Instagram's private API, which expects the same headers the page
//     itself would send.
//   - sendBatch(platform, items): hands a batch of normalized items to the
//     background service worker, which POSTs them to the Mission Control API
//     (content scripts don't have direct access to the extension's stored
//     apiUrl/captureKey, and posting through the service worker avoids any
//     page CSP restrictions on cross-origin fetches).
//   - reportProgress(platform, patch): broadcasts a progress update that the
//     popup listens for while an import is running.
//   - observeFetch(patterns, onMatch): passively watches the page's own
//     fetch calls (rather than synthesizing our own) for URLs matching any of
//     `patterns`, forwarding the response body. Used by the Twitter/X
//     importer — see page-fetch-relay.js for why.

(function () {
  if (window.__mcImportCommonLoaded) return;
  window.__mcImportCommonLoaded = true;

  let relayLoadPromise = null;
  let relayRequestId = 0;

  function injectRelay() {
    if (relayLoadPromise) return relayLoadPromise;

    relayLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('page-fetch-relay.js');
      script.addEventListener('load', () => {
        script.remove();
        resolve();
      }, { once: true });
      script.addEventListener('error', () => {
        script.remove();
        relayLoadPromise = null;
        reject(new Error('Failed to load the page fetch relay'));
      }, { once: true });
      (document.head || document.documentElement).appendChild(script);
    });

    return relayLoadPromise;
  }

  /**
   * Fetch a URL from the page's own JS context (MAIN world) so the request
   * carries the same cookies/headers the logged-in page would send.
   */
  async function relayFetch(url, options) {
    await injectRelay();
    const id = `mc-${Date.now()}-${relayRequestId++}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('mc-fetch-response', onResponse);
        reject(new Error(`Relay fetch timed out: ${url}`));
      }, 20000);

      function onResponse(e) {
        if (e.detail?.id !== id) return;
        clearTimeout(timeout);
        window.removeEventListener('mc-fetch-response', onResponse);
        if (e.detail.error) {
          reject(new Error(e.detail.error));
        } else {
          resolve({ status: e.detail.status, ok: e.detail.ok, body: e.detail.body });
        }
      }

      window.addEventListener('mc-fetch-response', onResponse);
      window.dispatchEvent(new CustomEvent('mc-fetch-request', { detail: { id, url, options } }));
    });
  }

  /**
   * Sends one batch of normalized TriageImportInput-shaped items to the
   * background service worker for ingestion. Resolves with
   * { imported, skipped, errors } or throws if the extension isn't
   * configured (apiUrl/captureKey missing).
   */
  async function sendBatch(platform, items) {
    if (!items.length) return { imported: 0, skipped: 0, errors: [] };
    const response = await chrome.runtime.sendMessage({ type: 'mc-bulk-import-batch', platform, items });
    if (!response || response.error) {
      throw new Error(response?.error || 'Bulk import request failed');
    }
    return response;
  }

  function reportProgress(platform, patch) {
    chrome.runtime.sendMessage({ type: 'mc-import-progress', platform, ...patch }).catch(() => {});
  }

  /**
   * Passively observes fetch responses the page makes on its own (rather than
   * synthesizing requests ourselves). Used by the Twitter/X importer, whose
   * internal GraphQL API has an undocumented, frequently-rotating queryId —
   * hardcoding it like the Instagram/TikTok endpoints would break unpredictably.
   * Instead we patch `fetch` once in the MAIN world (via page-fetch-relay.js)
   * and forward the body of any response whose URL contains one of `patterns`
   * to `onMatch(url, body)`. Returns a function that stops observing.
   */
  function observeFetch(patterns, onMatch) {
    let stopped = false;

    function handler(e) {
      const { url, body } = e.detail || {};
      if (!url) return;
      if (patterns.some((p) => url.includes(p))) {
        onMatch(url, body);
      }
    }

    window.addEventListener('mc-observed-response', handler);
    injectRelay().then(() => {
      if (stopped) return;
      for (const pattern of patterns) {
        window.dispatchEvent(new CustomEvent('mc-observe-fetch-pattern', { detail: { pattern } }));
      }
    }).catch((err) => {
      if (!stopped) console.error('[MC Triage] Failed to initialize fetch observer:', err);
    });

    return () => {
      stopped = true;
      window.removeEventListener('mc-observed-response', handler);
    };
  }

  window.MCImportCommon = { relayFetch, sendBatch, reportProgress, observeFetch };
})();
