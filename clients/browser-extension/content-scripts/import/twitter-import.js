// twitter-import.js — captures the logged-in user's X/Twitter Bookmarks and
// Likes into Mission Control's Triage Queue.
//
// Unlike Instagram/TikTok, X's Bookmarks/Likes data comes from an internal
// GraphQL API (`/i/api/graphql/{queryId}/OperationName`) where the queryId
// and required `features` payload are undocumented and rotate frequently.
// Hardcoding them would break unpredictably and needs re-reverse-engineering
// each time X ships a web client update. Instead of synthesizing our own
// requests, this passively observes the GraphQL responses the page *already*
// produces as the user scrolls their own Bookmarks/Likes timeline (via
// common.js's observeFetch, backed by the MAIN-world fetch patch in
// page-fetch-relay.js) and harvests tweets straight out of them. This makes
// zero extra network requests beyond the user's own browsing and self-heals
// when X changes its API shape, at the cost of requiring the user to scroll
// instead of a single "Import" click doing full auto-pagination.
//
// Both Bookmarks and Likes are newest-first, so once the backend starts
// reporting a batch as mostly/all duplicates, the user has caught back up to
// previously-imported tweets — but we don't auto-stop, since they may be
// revisiting a partial prior run rather than doing a fresh full pass.

const TWITTER_GRAPHQL_PATTERNS = ['/Bookmarks', '/Likes'];
const TWITTER_BATCH_SIZE = 25;

let stopObserving = null;
let sentIds = new Set();
let consecutiveHighSkipBatches = 0;
let importSession = null;
let processing = Promise.resolve();

/**
 * Recursively walks an arbitrary JSON tree looking for GraphQL "Tweet"
 * result objects. Deliberately shape-agnostic (rather than following a fixed
 * entries[].content.itemContent.tweet_results.result path) so it survives X
 * restructuring the surrounding timeline/instruction wrapper, which changes
 * far more often than the Tweet object itself.
 */
function findTweetResults(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) findTweetResults(item, out, seen);
    return;
  }

  const isTweetShaped =
    (node.__typename === 'Tweet' || node.__typename === 'TweetWithVisibilityResults') &&
    node.rest_id && node.legacy;
  const isWrapped = node.__typename === 'TweetWithVisibilityResults' && node.tweet;

  if (isTweetShaped) {
    const tweet = isWrapped ? node.tweet : node;
    if (tweet?.rest_id && tweet.legacy && !seen.has(tweet.rest_id)) {
      seen.add(tweet.rest_id);
      out.push(tweet);
    }
  }

  for (const key of Object.keys(node)) {
    findTweetResults(node[key], out, seen);
  }
}

function extractTweets(responseBody) {
  let payload;
  try {
    payload = JSON.parse(responseBody);
  } catch {
    return [];
  }
  const out = [];
  findTweetResults(payload, out, new Set());
  return out;
}

function getScreenName(tweet) {
  return (
    tweet?.core?.user_results?.result?.legacy?.screen_name ||
    tweet?.core?.user_results?.result?.core?.screen_name ||
    tweet?.legacy?.user?.legacy?.screen_name ||
    null
  );
}

function getDisplayName(tweet) {
  return (
    tweet?.core?.user_results?.result?.legacy?.name ||
    tweet?.core?.user_results?.result?.core?.name ||
    tweet?.legacy?.user?.legacy?.name ||
    null
  );
}

function extractMediaUrls(tweet) {
  const media = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media || [];
  return media
    .map((m) => {
      if (m.type === 'photo') return m.media_url_https;
      const variants = m.video_info?.variants || [];
      const best = [...variants]
        .filter((v) => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      return best?.url || m.media_url_https;
    })
    .filter(Boolean);
}

function extractThumbnailUrl(tweet) {
  const media = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media || [];
  return media[0]?.media_url_https || null;
}

/**
 * Normalizes a raw GraphQL Tweet result into Mission Control's import shape.
 * Uses the `/i/web/status/{id}` canonical URL, which resolves correctly
 * regardless of screen name, since screen_name isn't always resolvable from
 * every response shape.
 */
function normalizeTweet(tweet, sourceContext) {
  const id = tweet.rest_id;
  if (!id) return null;

  const legacy = tweet.legacy || {};
  const fullText = legacy.full_text || '';
  const screenName = getScreenName(tweet);
  const displayName = getDisplayName(tweet);
  const url = `https://x.com/i/web/status/${id}`;

  let capturedAt;
  if (legacy.created_at) {
    const parsed = new Date(legacy.created_at);
    if (!Number.isNaN(parsed.getTime())) capturedAt = parsed.toISOString();
  }

  return {
    sourcePlatform: 'twitter',
    sourceId: `twitter:${id}`,
    sourceUrl: url,
    canonicalUrl: url,
    title: fullText ? fullText.slice(0, 140) : (screenName ? `Tweet by @${screenName}` : 'Tweet'),
    description: fullText || undefined,
    capturedAt,
    thumbnailUrl: extractThumbnailUrl(tweet) || undefined,
    rawMetadata: {
      screenName: screenName || undefined,
      displayName: displayName || undefined,
      mediaUrls: extractMediaUrls(tweet),
      sourceContext,
      importedVia: 'browser_extension_bulk_import',
    },
  };
}

function detectSourceContext(url) {
  if (url.includes('/Bookmarks')) return 'bookmarks';
  if (url.includes('/Likes')) return 'likes';
  return 'unknown';
}

async function handleObservedResponse(url, body) {
  const { reportProgress } = window.MCImportCommon;
  const session = importSession;
  if (!session) return;
  const sourceContext = detectSourceContext(url);
  const tweets = extractTweets(body);
  if (!tweets.length) return;

  const fresh = [];
  for (const tweet of tweets) {
    if (sentIds.has(tweet.rest_id)) continue;
    sentIds.add(tweet.rest_id);
    const normalized = normalizeTweet(tweet, sourceContext);
    if (normalized) fresh.push(normalized);
  }
  if (!fresh.length) return;

  const before = session.snapshot();
  const after = await session.submit(fresh);
  const batchImported = after.imported - before.imported;
  const batchSkipped = after.skipped - before.skipped;

  // Track (but never act on) a run of mostly-duplicate batches — the user
  // may be revisiting a partial prior session rather than doing a fresh
  // full pass, so we surface a hint instead of auto-stopping.
  const batchSkipRatio = batchSkipped / (batchImported + batchSkipped || 1);
  if (batchSkipRatio > 0.8 && fresh.length >= 5) {
    consecutiveHighSkipBatches += 1;
  } else {
    consecutiveHighSkipBatches = 0;
  }
  const caughtUp = consecutiveHighSkipBatches >= 2;

  reportProgress('twitter', {
    live: true,
    imported: after.imported,
    skipped: after.skipped,
    done: false,
    hint: caughtUp
      ? 'Mostly seeing already-saved tweets — you may have reached where you left off. Keep scrolling if you want to go further back, or click Finish.'
      : undefined,
  });
}

function startTwitterCapture() {
  const { createImportSession, reportProgress, observeFetch } = window.MCImportCommon;

  // Content scripts persist across in-app (SPA) navigation on x.com/twitter.com
  // but not across a full page reload. So capture should be started *before*
  // navigating to the Bookmarks/Likes tab via X's own nav — that way the
  // GraphQL request triggered by that in-app navigation is already observed,
  // rather than missed because the observer wasn't installed yet.
  if (stopObserving) {
    const state = importSession.snapshot();
    reportProgress('twitter', { live: true, imported: state.imported, skipped: state.skipped, done: false, error: 'Capture already running.' });
    return;
  }

  sentIds = new Set();
  consecutiveHighSkipBatches = 0;
  importSession = createImportSession('twitter', TWITTER_BATCH_SIZE);
  processing = Promise.resolve();

  stopObserving = observeFetch(TWITTER_GRAPHQL_PATTERNS, (url, body) => {
    processing = processing
      .then(() => handleObservedResponse(url, body))
      .catch((error) => importSession?.addError(error));
  });

  reportProgress('twitter', {
    live: true,
    imported: 0,
    skipped: 0,
    done: false,
    hint: 'Capturing — open your Bookmarks or Likes tab (via X\'s own nav, not a page reload) and scroll to load more. Click Finish when done.',
  });
}

async function finishTwitterCapture() {
  if (stopObserving) {
    stopObserving();
    stopObserving = null;
  }
  await processing;
  importSession?.finish();
  importSession = null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.platform !== 'twitter') return undefined;

  if (message.type === 'mc-start-import') {
    startTwitterCapture();
    sendResponse({ started: true });
  } else if (message.type === 'mc-stop-import') {
    finishTwitterCapture().then(() => sendResponse({ stopped: true }));
    return true;
  }
  return undefined;
});
