// facebook-import.js — bulk-imports items from the logged-in user's
// Facebook "Saved" list into Mission Control's Triage Queue.
//
// Unlike Reddit/Instagram, Facebook has no documented/stable JSON endpoint
// for saved items (its GraphQL API is undocumented, versioned per-build, and
// scraping it would be brittle and likely against their ToS — see the
// reverse-engineering doc's "what we should NOT copy" section). Instead this
// scrolls the already-rendered Saved Items page and scrapes the visible
// DOM, which is slower but far more resilient to backend changes.
//
// Requires the user to already be on https://www.facebook.com/saved (or a
// collection view under it) — this script does not navigate for them.

const FB_SAVED_PATH_RE = /^\/(saved|save)(\/|$)/;
const FB_MAX_SCROLL_ROUNDS = 60;
const FB_SCROLL_WAIT_MS = 900;
const FB_STALL_ROUNDS_LIMIT = 4; // stop after N scrolls with no new items
const FB_BATCH_SIZE = 25;

// Facebook internal paths that are never real saved-content targets.
const FB_IGNORED_HREF_RE = /\/(saved|save|settings|help|privacy|policies|ads|business|watch\/live|groups\/feed|bookmarks)(\/|$|\?)/;

function isFacebookSavedPage() {
  return FB_SAVED_PATH_RE.test(window.location.pathname);
}

function toAbsoluteFacebookUrl(href) {
  try {
    const url = new URL(href, window.location.origin);
    url.hash = '';
    // Strip common tracking params so the same post doesn't get re-imported
    // under a slightly different query string.
    ['__tn__', '__cft__', 'ref', 'notif_id', 'notif_t'].forEach((p) => url.searchParams.delete(p));
    return url.toString();
  } catch {
    return null;
  }
}

function looksLikeContentHref(href) {
  if (!href) return false;
  if (FB_IGNORED_HREF_RE.test(href)) return false;
  return /\/(posts|videos|photo|photos|permalink|reel|watch|groups\/[^/]+\/(posts|permalink))\//.test(href)
    || /story_fbid=/.test(href)
    || /\/watch\/\?v=/.test(href);
}

/**
 * Scrapes anchors within the Saved list that point at real content
 * (posts/videos/photos), deduped by normalized URL, with a best-effort
 * title pulled from the nearest readable text.
 */
function scrapeVisibleSavedItems() {
  const found = new Map();
  const anchors = document.querySelectorAll('a[href]');

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href');
    if (!looksLikeContentHref(href)) continue;

    const absoluteUrl = toAbsoluteFacebookUrl(href);
    if (!absoluteUrl || found.has(absoluteUrl)) continue;

    // Walk up a few ancestors looking for a reasonably sized text blurb to
    // use as the title/description — Facebook's DOM has no stable class
    // names, so this is intentionally fuzzy.
    let title = anchor.textContent?.trim();
    let node = anchor;
    for (let depth = 0; depth < 4 && (!title || title.length < 8); depth += 1) {
      node = node.parentElement;
      if (!node) break;
      const text = node.textContent?.trim();
      if (text && text.length >= 8) title = text;
    }

    found.set(absoluteUrl, {
      sourcePlatform: 'facebook',
      sourceId: `facebook:${absoluteUrl}`,
      sourceUrl: absoluteUrl,
      canonicalUrl: absoluteUrl,
      title: (title || 'Facebook saved item').slice(0, 200),
      rawMetadata: {
        scrapeMethod: 'dom',
        importedVia: 'browser_extension_bulk_import',
      },
    });
  }

  return [...found.values()];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFacebookImport() {
  const { sendBatch, reportProgress } = window.MCImportCommon;

  if (!isFacebookSavedPage()) {
    reportProgress('facebook', { done: true, error: 'Open your Saved items page (facebook.com/saved) first, then try importing again.' });
    return;
  }

  const seen = new Set();
  let totalImported = 0;
  let totalSkipped = 0;
  let stallRounds = 0;
  const errors = [];

  for (let round = 0; round < FB_MAX_SCROLL_ROUNDS; round += 1) {
    const items = scrapeVisibleSavedItems().filter((item) => !seen.has(item.sourceUrl));

    if (items.length === 0) {
      stallRounds += 1;
    } else {
      stallRounds = 0;
      for (const item of items) seen.add(item.sourceUrl);

      for (let i = 0; i < items.length; i += FB_BATCH_SIZE) {
        const batch = items.slice(i, i + FB_BATCH_SIZE);
        try {
          const result = await sendBatch('facebook', batch);
          totalImported += result.imported;
          totalSkipped += result.skipped;
          if (result.errors?.length) errors.push(...result.errors);
        } catch (err) {
          errors.push(err.message || 'Failed to submit batch');
        }
      }
      reportProgress('facebook', { imported: totalImported, skipped: totalSkipped, done: false });
    }

    if (stallRounds >= FB_STALL_ROUNDS_LIMIT) break;

    window.scrollTo(0, document.body.scrollHeight);
    await wait(FB_SCROLL_WAIT_MS);
  }

  reportProgress('facebook', { imported: totalImported, skipped: totalSkipped, errors: errors.slice(0, 10), done: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mc-start-import' && message.platform === 'facebook') {
    runFacebookImport();
    sendResponse({ started: true });
  }
});
