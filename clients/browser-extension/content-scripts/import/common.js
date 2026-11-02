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
  let runId = null;

  function startImport(platform, run, message, sendResponse) {
    runId = message.runId || null;
    Promise.resolve().then(run).catch((error) => {
      reportProgress(platform, { done: true, error: errorMessage(error, 'Import failed') });
    });
    sendResponse({ started: true });
  }

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
    const response = await chrome.runtime.sendMessage({ type: 'mc-bulk-import-batch', platform, items, runId });
    if (!response || response.error) {
      throw new Error(response?.error || 'Bulk import request failed');
    }
    return response;
  }

  function reportProgress(platform, patch) {
    chrome.runtime.sendMessage({ type: 'mc-import-progress', platform, runId, ...patch })
      .then((response) => {
        if (response?.error) console.error('[MC Triage] Could not save import progress:', response.error);
      })
      .catch((error) => console.error('[MC Triage] Could not report import progress:', error));
  }

  function errorMessage(error, fallback) {
    return error?.message || fallback;
  }

  function createImportSession(platform, batchSize = 25, scope = window.location.pathname, getTotals = () => ({ imported: 0, skipped: 0 })) {
    let imported = 0;
    let skipped = 0;
    const errors = [];
    let historyPromise;
    let history;

    async function loadHistory() {
      if (!historyPromise) {
        historyPromise = chrome.runtime.sendMessage({
          type: 'mc-get-import-checkpoint', platform, scope, runId,
        }).then((response) => {
          if (response?.error) throw new Error(response.error);
          history = response?.checkpoint || { seenIds: [], completed: false, ordered: false };
          return history;
        });
      }
      return historyPromise;
    }

    async function saveHistory(patch = {}) {
      await loadHistory();
      Object.assign(history, { lastImportedAt: new Date().toISOString() }, patch);
      const response = await chrome.runtime.sendMessage({
        type: 'mc-save-import-checkpoint', platform, scope, runId, checkpoint: history,
      });
      if (response?.error) throw new Error(response.error);
    }

    function addError(error, fallback = 'Import failed') {
      errors.push(errorMessage(error, fallback));
    }

    async function submit(items) {
      const checkpoint = await loadHistory();
      const known = new Set(checkpoint.seenIds);
      const fresh = items.filter((item) => !item.sourceId || !known.has(item.sourceId));
      skipped += items.length - fresh.length;
      for (let index = 0; index < fresh.length; index += batchSize) {
        const batch = fresh.slice(index, index + batchSize);
        try {
          const result = await sendBatch(platform, batch);
          imported += result.imported ?? 0;
          skipped += result.skipped ?? 0;
          if (Array.isArray(result.errors)) errors.push(...result.errors);
          if (!result.errors?.length && (result.imported ?? 0) + (result.skipped ?? 0) === batch.length) {
            for (const item of batch) if (item.sourceId) known.add(item.sourceId);
            await saveHistory({
              seenIds: [...known],
              lastImportedAt: new Date().toISOString(),
              earliestItem: checkpoint.earliestItem || (batch.at(-1)?.sourceId ? {
                sourceId: batch.at(-1).sourceId,
                sourceUrl: batch.at(-1).sourceUrl,
              } : undefined),
            });
          } else if (!result.errors?.length) {
            addError(new Error('The server did not acknowledge every item. Retry the import.'));
          }
        } catch (error) {
          addError(error, 'Failed to submit batch');
        }
        const totals = getTotals();
        reportProgress(platform, { imported: imported + totals.imported, skipped: skipped + totals.skipped, done: false });
      }
      if (!fresh.length) {
        const totals = getTotals();
        reportProgress(platform, { imported: imported + totals.imported, skipped: skipped + totals.skipped, done: false });
      }
      return snapshot();
    }

    function snapshot() {
      return { imported, skipped, errors };
    }

    function merge(result) {
      imported += result.imported;
      skipped += result.skipped;
      errors.push(...result.errors);
      reportProgress(platform, { imported, skipped, done: false });
    }

    async function finish(patch = {}) {
      try {
        if (!errors.length) await saveHistory({ completed: patch.completed === true });
      } catch (error) {
        addError(error, 'Could not save import history');
      }
      reportProgress(platform, {
        imported,
        skipped,
        errors: errors.slice(0, 10),
        done: true,
        ...patch,
        completed: patch.completed === true && !errors.length,
      });
      return snapshot();
    }

    return { addError, finish, snapshot, submit, loadHistory, saveHistory, merge };
  }

  async function collectPages({ maxPages, initialCursor, fetchPage }) {
    const items = [];
    let cursor = initialCursor;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await fetchPage(cursor, page);
      if (Array.isArray(result.items)) items.push(...result.items);
      if (result.nextCursor == null) break;
      if (result.nextCursor === cursor) throw new Error('Pagination cursor did not advance. Rescan saved history and try again.');
      if (page === maxPages - 1) throw new Error('The page limit was reached before the list finished. Try importing a specific collection or board.');
      cursor = result.nextCursor;
    }
    return items;
  }

  async function runPagedImport({
    platform,
    batchSize = 25,
    maxPages,
    initialCursor,
    fetchPage,
    normalizeItems = (items) => items,
    scope,
    session: existingSession,
    ordered = true,
  }) {
    const session = existingSession || createImportSession(platform, batchSize, scope);
    let cursor = initialCursor;
    let completed = false;

    try {
      const history = await session.loadHistory();
      history.ordered = ordered;
      const previousHead = ordered ? history.newestId : null;
      const previousResume = history.resumeCursor;
      const previouslyCompleted = history.completed;
      let connected = !previousHead;
      let newestId;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await fetchPage(cursor, page);
        const items = normalizeItems(result.items || [], result, page).filter(Boolean);
        newestId ||= items[0]?.sourceId;
        const boundary = previousHead ? items.findIndex((item) => item.sourceId === previousHead) : -1;
        const errorsBefore = session.snapshot().errors.length;
        await session.submit(boundary >= 0 ? items.slice(0, boundary) : items);
        if (session.snapshot().errors.length > errorsBefore) break;

        if (!connected && boundary >= 0) {
          connected = true;
          if (previouslyCompleted) {
            completed = true;
            await session.saveHistory({ newestId: newestId || previousHead, completed: true });
            break;
          }
          // The old prefix is already acknowledged. Resume its unfinished tail.
          cursor = previousResume ?? initialCursor;
          await session.saveHistory({ newestId: newestId || previousHead });
          continue;
        }
        if (result.nextCursor == null) {
          completed = true;
          await session.saveHistory({
            completed: true, resumeCursor: null, newestId: newestId || previousHead,
            ...(items.at(-1)?.sourceId ? { earliestItem: {
              sourceId: items.at(-1).sourceId, sourceUrl: items.at(-1).sourceUrl,
            } } : {}),
          });
          break;
        }
        if (result.nextCursor === cursor) throw new Error('Pagination cursor did not advance. Rescan saved history and try again.');
        if (connected || page === maxPages - 1) {
          await session.saveHistory({
            completed: false, resumeCursor: result.nextCursor, newestId: newestId || previousHead,
            ...(items.at(-1)?.sourceId ? { earliestItem: {
              sourceId: items.at(-1).sourceId, sourceUrl: items.at(-1).sourceUrl,
            } } : {}),
          });
        }
        cursor = result.nextCursor;
      }
    } catch (error) {
      completed = false;
      session.addError(error);
    }

    if (!existingSession) await session.finish({
      completed,
      hint: completed ? 'Caught up with saved history.' : 'History incomplete. Run again to continue.',
    });
    return { ...session.snapshot(), completed: completed && !session.snapshot().errors.length };
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

  window.MCImportCommon = {
    collectPages,
    createImportSession,
    observeFetch,
    relayFetch,
    reportProgress,
    runPagedImport,
    sendBatch,
    startImport,
  };
})();
