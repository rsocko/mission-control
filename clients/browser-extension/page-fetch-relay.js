// page-fetch-relay.js — MAIN world authenticated fetch relay
// Injected into the page's MAIN world context (not the isolated
// content-script world) by content-scripts/import/common.js so `fetch` runs
// with the same cookies/auth as the logged-in page. Used by the Instagram
// bulk-import content script to call Instagram's private API with the
// page's own session; Reddit/Facebook don't need it (Reddit's endpoint works
// with a plain same-origin fetch, Facebook import scrapes the DOM instead).

if (!window.__mcRelayInstalled) {
  window.__mcRelayInstalled = true;
  window.addEventListener('mc-relay-check', () => {
    window.dispatchEvent(new CustomEvent('mc-relay-ready'));
  });
  window.addEventListener('mc-fetch-request', async (e) => {
    const { id, url, options } = e.detail;
    try {
      const resp = await fetch(url, options);
      const body = await resp.text();
      window.dispatchEvent(new CustomEvent('mc-fetch-response', {
        detail: { id, status: resp.status, ok: resp.ok, body }
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent('mc-fetch-response', {
        detail: { id, error: err.message }
      }));
    }
  });
}

// ─── Passive fetch observer ──────────────────────────────────────────────────
//
// Used by the Twitter/X bulk-import content script. X's Bookmarks/Likes data
// comes from an internal GraphQL API (`/i/api/graphql/{queryId}/OperationName`)
// where the queryId and required `features` payload are undocumented and
// rotate frequently — hardcoding them (like the Instagram/TikTok importers do
// with their stable REST endpoints) would break unpredictably. Instead of
// synthesizing our own requests, we patch `fetch` once to observe requests the
// page makes while the importer scrolls its Bookmarks/Likes timeline.
// Both fetch and XHR are observed, including requests before Import is clicked.
if (!window.__mcFetchObserverInstalled) {
  window.__mcFetchObserverInstalled = true;
  const originalFetch = window.fetch;
  const isTwitter = /(^|\.)((x|twitter)\.com)$/.test(window.location.hostname);
  const patterns = new Set(isTwitter ? ['/Bookmarks', '/Likes'] : []);
  const buffered = new Map();

  function publish(url, body, status) {
    if (![...patterns].some((pattern) => url.includes(pattern))) return;
    const detail = { url, body, status };
    if (isTwitter) {
      buffered.delete(url);
      buffered.set(url, detail);
      if (buffered.size > 20) buffered.delete(buffered.keys().next().value);
    }
    window.dispatchEvent(new CustomEvent('mc-observed-response', { detail }));
  }

  window.addEventListener('mc-observe-fetch-pattern', (e) => {
    const pattern = e.detail?.pattern;
    if (typeof pattern === 'string' && pattern) {
      patterns.add(pattern);
      for (const detail of buffered.values()) {
        if (detail.url.includes(pattern)) {
          window.dispatchEvent(new CustomEvent('mc-observed-response', { detail: { ...detail, buffered: true } }));
        }
      }
    }
  });

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
      if (url && patterns.size) {
        for (const pattern of patterns) {
          if (url.includes(pattern)) {
            const clone = response.clone();
            clone.text().then((body) => {
              publish(url, body, response.status);
            }).catch((error) => console.warn('[MC Triage] Could not read observed fetch:', error));
            break;
          }
        }
      }
    } catch (error) {
      console.warn('[MC Triage] Could not observe fetch:', error);
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requestUrls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requestUrls.set(this, String(url));
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      const url = requestUrls.get(this);
      if (!url || ![...patterns].some((pattern) => url.includes(pattern))) return;
      try {
        const body = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
        publish(url, body, this.status);
      } catch (error) {
        console.warn('[MC Triage] Could not read observed XHR:', error);
      }
    }, { once: true });
    return originalSend.apply(this, args);
  };
}

console.log('[MC Triage] Page-fetch relay loaded');
