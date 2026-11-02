// twitter-import.js — captures the logged-in user's X/Twitter Bookmarks and
// Likes into Mission Control's Triage Queue.
//
// Uses X's native timeline to load older items automatically, without
// hardcoded GraphQL query IDs, feature flags, or signed request headers.
// The document-start relay buffers fetch/XHR responses; DOM capture also
// includes tweets that were rendered before the extension started importing.

const TWITTER_GRAPHQL_PATTERNS = ['/Bookmarks', '/Likes'];
const TWITTER_BATCH_SIZE = 25;

let stopObserving = null;
let sentIds = new Set();
let consecutiveHighSkipBatches = 0;
let importSession = null;
let processing = Promise.resolve();
let captureTask = null;
let cancelled = false;
let reachedEnd = false;
let activeContext = null;
let activity = 0;

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
    return; // Quoted/retweeted objects are not separate saved-list entries.
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
    throw new Error('X returned an unreadable saved-items response. Reload X and try again.');
  }
  if (payload.errors?.length) throw new Error(payload.errors[0].message || 'X could not load saved items.');
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
  const fullText = tweet.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '';
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

function hasTimelineEnd(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'TimelineTerminateTimeline' && node.direction === 'Bottom') return true;
  if (node.cursorType === 'Bottom' && node.value === '') return true;
  return Object.values(node).some(hasTimelineEnd);
}

function visibleTweets() {
  return [...document.querySelectorAll('article[data-testid="tweet"]')].flatMap((article) => {
    const time = article.querySelector('time');
    const link = time?.closest('a')?.getAttribute('href');
    const id = link?.match(/\/status\/(\d+)/)?.[1];
    if (!id) return [];
    return [{
      rest_id: id,
      legacy: {
        full_text: article.querySelector('[data-testid="tweetText"]')?.textContent || '',
        created_at: time.getAttribute('datetime'),
        entities: { media: [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map((img) => ({
          type: 'photo', media_url_https: img.src,
        })) },
      },
    }];
  });
}

async function submitTweets(tweets, sourceContext) {
  const { reportProgress } = window.MCImportCommon;
  const session = importSession;
  if (!session) return;
  if (!tweets.length) return;

  const fresh = [];
  for (const tweet of tweets) {
    if (sentIds.has(tweet.rest_id)) continue;
    sentIds.add(tweet.rest_id);
    const normalized = normalizeTweet(tweet, sourceContext);
    if (normalized) fresh.push(normalized);
  }
  if (!fresh.length) return;
  activity += 1;

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
      ? 'Mostly seeing already-saved tweets. Automatically checking older items; click Finish to stop.'
      : undefined,
  });
}

async function handleObservedResponse(url, body, status, buffered) {
  if (detectSourceContext(url) !== activeContext) return;
  if (status >= 400) throw new Error(`X saved-items request failed (${status}). Reload X and try again.`);
  const tweets = extractTweets(body);
  activity += 1;
  if (!buffered) reachedEnd ||= hasTimelineEnd(JSON.parse(body));
  await submitTweets(tweets, activeContext);
}

async function runTwitterCapture() {
  let idle = 0;
  let previousActivity = -1;
  const startPath = window.location.pathname;
  try {
    await Promise.resolve();
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (let step = 0; step < 200 && !cancelled; step += 1) {
      if (window.location.pathname !== startPath || getActiveContext() !== activeContext) {
        throw new Error('The X saved feed changed. Return to the feed and start a new import.');
      }
      // Serialize DOM and API batches so concurrent checkpoint writes cannot
      // lose acknowledged IDs. Buffered API metadata wins over the fallback.
      processing = processing
        .then(() => submitTweets(visibleTweets(), activeContext))
        .catch((error) => importSession.addError(error));
      await processing;
      if (importSession.snapshot().errors.length || reachedEnd) break;
      idle = activity === previousActivity ? idle + 1 : 0;
      previousActivity = activity;
      if (idle >= 10) break;
      const scroller = document.scrollingElement || document.documentElement;
      window.scrollTo({
        top: Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(400, window.innerHeight * 0.8)),
        behavior: 'instant',
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    importSession.addError(error);
  } finally {
    stopObserving?.();
    stopObserving = null;
    await processing;
    const state = importSession.snapshot();
    if (!cancelled && !state.imported && !state.skipped && !reachedEnd && !state.errors.length) {
      importSession.addError(new Error('No saved tweets were found. Open your Bookmarks or Likes feed, reload X, and try again.'));
    }
    await importSession.finish({
      completed: reachedEnd && !cancelled,
      hint: reachedEnd && !cancelled
        ? 'X confirmed the end of this saved feed.'
        : 'History incomplete. Run again to continue; already-saved items will be skipped.',
    });
    importSession = null;
  }
}

function getActiveContext() {
  if (/\/likes\/?$/.test(window.location.pathname)) return 'likes';
  const tab = document.querySelector('[role="tab"][aria-selected="true"]')?.textContent || '';
  return /likes/i.test(tab) ? 'likes' : 'bookmarks';
}

function startTwitterCapture() {
  const { createImportSession, reportProgress, observeFetch } = window.MCImportCommon;

  if (importSession) {
    const state = importSession.snapshot();
    reportProgress('twitter', { live: true, imported: state.imported, skipped: state.skipped, done: false, error: 'Capture already running.' });
    return;
  }

  sentIds = new Set();
  consecutiveHighSkipBatches = 0;
  cancelled = false;
  reachedEnd = false;
  activity = 0;
  activeContext = getActiveContext();
  const accountCookie = document.cookie.split('; ').find((cookie) => cookie.startsWith('twid='))?.slice(5);
  const account = accountCookie ? decodeURIComponent(accountCookie).replace(/^u=/, '') : null;
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
  const username = profile?.match(/^\/([^/]+)\/?$/)?.[1];
  importSession = createImportSession('twitter', TWITTER_BATCH_SIZE, `${account || username || `unknown-${Date.now()}`}:${activeContext}`);
  processing = Promise.resolve();

  stopObserving = observeFetch(TWITTER_GRAPHQL_PATTERNS, (url, body, status, buffered) => {
    processing = processing
      .then(() => handleObservedResponse(url, body, status, buffered))
      .catch((error) => importSession?.addError(error));
  }, (error) => importSession?.addError(error));

  reportProgress('twitter', {
    live: true,
    imported: 0,
    skipped: 0,
    done: false,
    hint: 'Importing this saved feed and loading older items automatically. Keep this tab open; click Finish to stop.',
  });
  captureTask = runTwitterCapture();
  return captureTask;
}

async function finishTwitterCapture() {
  cancelled = true;
  await captureTask;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.platform !== 'twitter') return undefined;

  if (message.type === 'mc-start-import') {
    window.MCImportCommon.startImport('twitter', startTwitterCapture, message, sendResponse);
  } else if (message.type === 'mc-stop-import') {
    finishTwitterCapture().then(() => sendResponse({ stopped: true }));
    return true;
  }
  return undefined;
});
