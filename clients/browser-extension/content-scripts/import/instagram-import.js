// instagram-import.js — bulk-imports the logged-in user's Instagram saved
// posts into Mission Control's Triage Queue via Instagram's private
// `/api/v1/feed/saved/posts/` endpoint.
//
// Instagram requires an `x-csrftoken` cookie plus an `x-ig-app-id` header
// that's only discoverable by scraping the page's inline <script> tags, and
// the fetch itself needs to run with the page's own session — so this uses
// the MAIN-world page-fetch-relay (see import/common.js) rather than a
// direct isolated-world fetch.

const IG_MAX_PAGES = 50;
const IG_BATCH_SIZE = 25;

function getInstagramCsrfToken() {
  const match = document.cookie.split('; ').find((c) => c.startsWith('csrftoken='));
  return match ? match.split('=')[1] : null;
}

function getInstagramAppId() {
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const match = (s.textContent || '').match(/["']X-IG-App-ID["']\s*:\s*["'](\d+)["']/);
    if (match) return match[1];
  }
  return null;
}

function detectInstagramAuth() {
  const csrfToken = getInstagramCsrfToken();
  if (!csrfToken) return null;
  const appId = getInstagramAppId();
  if (!appId) return null;
  return { csrfToken, appId };
}

function largestCandidateUrl(imageVersions2) {
  const candidates = imageVersions2?.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  return [...candidates].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
}

function extractMediaUrls(item) {
  const urls = [];

  if (item.media_type === 8 && Array.isArray(item.carousel_media)) {
    for (const sub of item.carousel_media) {
      const videoUrl = sub.video_versions?.[0]?.url;
      const imageUrl = largestCandidateUrl(sub.image_versions2);
      urls.push(videoUrl || imageUrl);
    }
  } else if (item.media_type === 2) {
    urls.push(item.video_versions?.[0]?.url);
  } else if (item.media_type === 1) {
    urls.push(largestCandidateUrl(item.image_versions2));
  }

  return urls.filter(Boolean);
}

function extractThumbnailUrl(item) {
  // For carousel posts, use the first item's image
  if (item.media_type === 8 && Array.isArray(item.carousel_media) && item.carousel_media.length) {
    const first = item.carousel_media[0];
    return largestCandidateUrl(first.image_versions2) || null;
  }
  // For video posts, prefer the first frame / cover image
  if (item.media_type === 2) {
    return largestCandidateUrl(item.image_versions2) || null;
  }
  // For image posts
  return largestCandidateUrl(item.image_versions2) || null;
}

function normalizeInstagramItem(entry) {
  // Saved-posts feed items wrap the actual media under `media`.
  const item = entry.media || entry;
  if (!item?.code) return null;

  const username = item.user?.username;
  const caption = item.caption?.text;
  const thumbnailUrl = extractThumbnailUrl(item);

  return {
    sourcePlatform: 'instagram',
    sourceId: `instagram:${item.code}`,
    sourceUrl: `https://www.instagram.com/p/${item.code}/`,
    canonicalUrl: `https://www.instagram.com/p/${item.code}/`,
    title: caption ? caption.slice(0, 140) : (username ? `Instagram post by @${username}` : 'Instagram saved post'),
    description: caption,
    capturedAt: item.taken_at ? new Date(item.taken_at * 1000).toISOString() : undefined,
    thumbnailUrl: thumbnailUrl || undefined,
    rawMetadata: {
      mediaType: item.media_type,
      mediaUrls: extractMediaUrls(item),
      thumbnailUrl: thumbnailUrl || undefined,
      creator: username ? { username, displayName: item.user?.full_name, profileUrl: `https://www.instagram.com/${username}/` } : undefined,
      collectionIds: Array.isArray(item.saved_collection_ids) ? item.saved_collection_ids.map(String) : undefined,
      importedVia: 'browser_extension_bulk_import',
    },
  };
}

/**
 * Detect the collection ID from the current page URL or DOM.
 * Instagram saved collection URLs look like: /username/saved/collection-name/collection-id/
 * The "All Posts" page is /username/saved/all-posts/ (no numeric ID).
 */
function detectCollectionId() {
  const path = window.location.pathname;
  // Match /username/saved/collection-name/numeric-id/
  const match = path.match(/\/[^/]+\/saved\/[^/]+\/(\d+)\/?$/);
  return match ? match[1] : null;
}

async function runInstagramImport(options) {
  const { relayFetch, sendBatch, reportProgress } = window.MCImportCommon;
  const auth = detectInstagramAuth();

  if (!auth) {
    reportProgress('instagram', { done: true, error: 'Not logged in to Instagram (or auth tokens not found). Refresh instagram.com and try again.' });
    return;
  }

  // Determine which feed to fetch: a specific collection or all saved posts
  const collectionId = options?.collectionId || detectCollectionId();

  let maxId;
  let page = 0;
  let totalImported = 0;
  let totalSkipped = 0;
  const errors = [];

  while (page < IG_MAX_PAGES) {
    const url = collectionId
      ? new URL(`https://www.instagram.com/api/v1/feed/saved/collection/${collectionId}/`)
      : new URL('https://www.instagram.com/api/v1/feed/saved/posts/');
    if (maxId) url.searchParams.set('max_id', maxId);

    let response;
    try {
      response = await relayFetch(url.toString(), {
        method: 'GET',
        credentials: 'include',
        headers: {
          'x-csrftoken': auth.csrfToken,
          'x-ig-app-id': auth.appId,
          'x-requested-with': 'XMLHttpRequest',
        },
      });
    } catch (err) {
      errors.push(err.message || 'Network error fetching Instagram saved posts');
      break;
    }

    if (!response.ok) {
      errors.push(`Instagram saved posts request failed: ${response.status}`);
      break;
    }

    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      errors.push('Instagram saved posts response was not valid JSON');
      break;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const normalized = items.map(normalizeInstagramItem).filter(Boolean);

    for (let i = 0; i < normalized.length; i += IG_BATCH_SIZE) {
      const batch = normalized.slice(i, i + IG_BATCH_SIZE);
      try {
        const result = await sendBatch('instagram', batch);
        totalImported += result.imported;
        totalSkipped += result.skipped;
        if (result.errors?.length) errors.push(...result.errors);
      } catch (err) {
        errors.push(err.message || 'Failed to submit batch');
      }
      reportProgress('instagram', { imported: totalImported, skipped: totalSkipped, done: false });
    }

    page += 1;
    if (!payload.more_available || !payload.next_max_id) break;
    maxId = payload.next_max_id;
  }

  reportProgress('instagram', { imported: totalImported, skipped: totalSkipped, errors: errors.slice(0, 10), done: true });
}

function getLoggedInUsername() {
  // Try extracting from Instagram's inline config/shared data
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent || '';
    // Look for viewer username in shared data or config
    const match = text.match(/"username"\s*:\s*"([A-Za-z0-9._]+)".*?"is_private"/);
    if (match) return match[1];
    const viewerMatch = text.match(/viewer.*?"username"\s*:\s*"([A-Za-z0-9._]+)"/s);
    if (viewerMatch) return viewerMatch[1];
  }
  // Fallback: look for profile link in navigation
  const profileLink = document.querySelector('a[href*="/"]:not([href="/"])');
  if (profileLink) {
    const href = profileLink.getAttribute('href');
    const m = href?.match(/^\/([A-Za-z0-9._]+)\/$/);
    if (m) return m[1];
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mc-start-import' && message.platform === 'instagram') {
    runInstagramImport();
    sendResponse({ started: true });
  }
  if (message?.type === 'mc-get-instagram-username') {
    sendResponse({ username: getLoggedInUsername() });
  }
});
