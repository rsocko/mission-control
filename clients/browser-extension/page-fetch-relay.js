// page-fetch-relay.js — MAIN world authenticated fetch relay
// Injected into the page's MAIN world context (not the isolated
// content-script world) by content-scripts/import/common.js so `fetch` runs
// with the same cookies/auth as the logged-in page. Used by the Instagram
// bulk-import content script to call Instagram's private API with the
// page's own session; Reddit/Facebook don't need it (Reddit's endpoint works
// with a plain same-origin fetch, Facebook import scrapes the DOM instead).

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

// ─── Passive fetch observer ──────────────────────────────────────────────────
//
// Used by the Twitter/X bulk-import content script. X's Bookmarks/Likes data
// comes from an internal GraphQL API (`/i/api/graphql/{queryId}/OperationName`)
// where the queryId and required `features` payload are undocumented and
// rotate frequently — hardcoding them (like the Instagram/TikTok importers do
// with their stable REST endpoints) would break unpredictably. Instead of
// synthesizing our own requests, we patch `fetch` once to observe requests the
// page *already makes itself* as the user scrolls their own Bookmarks/Likes
// timeline, and harvest tweets straight out of those responses. This makes
// zero extra network requests and self-heals when X changes its API shape.
if (!window.__mcFetchObserverInstalled) {
  window.__mcFetchObserverInstalled = true;
  const originalFetch = window.fetch;
  const patterns = new Set();

  window.addEventListener('mc-observe-fetch-pattern', (e) => {
    const pattern = e.detail?.pattern;
    if (typeof pattern === 'string' && pattern) patterns.add(pattern);
  });

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && patterns.size) {
        for (const pattern of patterns) {
          if (url.includes(pattern)) {
            const clone = response.clone();
            clone.text().then((body) => {
              window.dispatchEvent(new CustomEvent('mc-observed-response', {
                detail: { url, body },
              }));
            }).catch(() => {});
            break;
          }
        }
      }
    } catch { /* never let observation break the page's real fetch */ }
    return response;
  };
}

console.log('[MC Triage] Page-fetch relay loaded');
