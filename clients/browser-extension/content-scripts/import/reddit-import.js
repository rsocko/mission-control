// reddit-import.js — bulk-imports the logged-in user's Reddit saved posts
// and comments into Mission Control's Triage Queue.
//
// Reddit's saved.json endpoint works with plain cookie auth (no CSRF/app-id
// dance needed), so this fetches directly from the content script's
// isolated world — same-origin requests automatically carry the page's
// session cookies, no MAIN-world relay required.

const REDDIT_PAGE_SIZE = 100;
const REDDIT_MAX_PAGES = 50;
const REDDIT_BATCH_SIZE = 25;

function extractRedditUsernameFromPage() {
  // Try the URL first (works when on /user/<name>/saved).
  const pathMatch = window.location.pathname.match(/\/(?:user|u)\/([^/]+)/);
  if (pathMatch) return pathMatch[1];

  // Fall back to the profile link in the page header.
  const profileLink = document.querySelector('a[href^="/user/"]');
  if (profileLink) {
    const match = profileLink.getAttribute('href')?.match(/\/user\/([^/]+)/);
    if (match) return match[1];
  }

  return null;
}

async function fetchRedditUsername() {
  // Use Reddit's API to get the logged-in username (works from any Reddit page).
  try {
    const resp = await fetch('https://www.reddit.com/api/v1/me.json', { credentials: 'include' });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.name || null;
  } catch {
    return null;
  }
}

async function extractRedditUsername() {
  // Fast synchronous check first, then fall back to API call.
  const fromPage = extractRedditUsernameFromPage();
  if (fromPage) return fromPage;
  return fetchRedditUsername();
}

function toIsoFromUnix(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return new Date(value * 1000).toISOString();
}

function toAbsoluteRedditUrl(pathOrUrl) {
  if (typeof pathOrUrl !== 'string' || !pathOrUrl.trim()) return null;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return `https://www.reddit.com${pathOrUrl}`;
  return null;
}

function decodeRedditUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('http')) return null;
  return url.replace(/&amp;/g, '&');
}

function extractRedditThumbnailUrl(data) {
  // 1. Animated GIF variant (full quality animated image — renders in <img> tag)
  const gifVariant = decodeRedditUrl(data.preview?.images?.[0]?.variants?.gif?.source?.url);
  if (gifVariant) return gifVariant;

  // 2. Direct i.redd.it URL — full quality original (GIF, PNG, JPG)
  const overriddenUrl = data.url_overridden_by_dest;
  if (typeof overriddenUrl === 'string' && overriddenUrl.includes('i.redd.it') && overriddenUrl.startsWith('http')) {
    return overriddenUrl;
  }

  // 3. High-res preview source image (static JPEG)
  const previewSource = decodeRedditUrl(data.preview?.images?.[0]?.source?.url);
  if (previewSource) return previewSource;

  // 4. First preview resolution
  const previewRes = decodeRedditUrl(data.preview?.images?.[0]?.resolutions?.[0]?.url);
  if (previewRes) return previewRes;

  // 5. Gallery posts: media_metadata first key source URL
  const mediaMeta = data.media_metadata;
  if (mediaMeta && typeof mediaMeta === 'object') {
    const firstKey = Object.keys(mediaMeta)[0];
    if (firstKey) {
      // Prefer GIF URL from gallery metadata
      const galleryGif = decodeRedditUrl(mediaMeta[firstKey]?.s?.gif);
      if (galleryGif) return galleryGif;

      const gallerySource = decodeRedditUrl(mediaMeta[firstKey]?.s?.u);
      if (gallerySource) return gallerySource;

      const galleryThumb = decodeRedditUrl(mediaMeta[firstKey]?.p?.[0]?.u);
      if (galleryThumb) return galleryThumb;
    }
  }

  // 6. Skip v.redd.it URLs — they are video URLs, not images.

  // 7. Fall back to thumbnail field (lower res but widely available)
  if (typeof data.thumbnail === 'string' && data.thumbnail.startsWith('http')) return data.thumbnail;
  return null;
}

function extractRedditVideoUrl(data) {
  // 1. MP4 variant from preview (GIF posts converted to mp4)
  const mp4Variant = decodeRedditUrl(data.preview?.images?.[0]?.variants?.mp4?.source?.url);
  if (mp4Variant) return mp4Variant;

  // 2. Reddit-hosted video
  const redditVideo = data.media?.reddit_video?.fallback_url || data.secure_media?.reddit_video?.fallback_url;
  if (redditVideo) return redditVideo;

  // 3. Cross-posted video preview
  const videoPreview = data.preview?.reddit_video_preview?.fallback_url;
  if (videoPreview) return videoPreview;

  // 4. v.redd.it URL from url_overridden_by_dest
  const overriddenUrl = data.url_overridden_by_dest;
  if (typeof overriddenUrl === 'string' && overriddenUrl.includes('v.redd.it') && overriddenUrl.startsWith('http')) {
    return overriddenUrl;
  }

  return null;
}

function extractRedditGalleryUrls(data) {
  const mediaMeta = data.media_metadata;
  if (!mediaMeta || typeof mediaMeta !== 'object') return null;

  const galleryData = data.gallery_data;
  const orderedKeys = galleryData?.items?.map((item) => item.media_id) || Object.keys(mediaMeta);

  if (orderedKeys.length <= 1) return null;

  const urls = [];
  for (const key of orderedKeys) {
    const entry = mediaMeta[key];
    if (!entry) continue;
    const url = decodeRedditUrl(entry.s?.gif) || decodeRedditUrl(entry.s?.u);
    if (url) urls.push(url);
  }

  return urls.length > 1 ? urls : null;
}

function normalizeRedditChild(child) {
  const data = child.data || {};
  const sourceId = typeof data.name === 'string' ? `reddit:${data.name}` : null;
  if (!sourceId) return null;

  if (child.kind === 't3') {
    const permalink = toAbsoluteRedditUrl(data.permalink);
    const overriddenUrl = toAbsoluteRedditUrl(data.url_overridden_by_dest);
    const sourceUrl = overriddenUrl || permalink;
    if (!sourceUrl) return null;
    const thumbnailUrl = extractRedditThumbnailUrl(data);
    const galleryUrls = extractRedditGalleryUrls(data);
    const videoUrl = extractRedditVideoUrl(data);

    return {
      sourcePlatform: 'reddit',
      sourceId,
      sourceUrl,
      canonicalUrl: overriddenUrl || sourceUrl,
      title: typeof data.title === 'string' ? data.title : 'Reddit saved post',
      description: typeof data.selftext === 'string' && data.selftext.trim()
        ? data.selftext
        : (typeof data.subreddit_name_prefixed === 'string' ? data.subreddit_name_prefixed : undefined),
      capturedAt: toIsoFromUnix(data.created_utc),
      thumbnailUrl: thumbnailUrl || undefined,
      rawMetadata: {
        subreddit: data.subreddit,
        subredditNamePrefixed: data.subreddit_name_prefixed,
        author: data.author,
        score: data.score,
        comments: data.num_comments,
        permalink,
        thumbnailUrl: thumbnailUrl || undefined,
        kind: child.kind,
        importedVia: 'browser_extension_bulk_import',
        ...(galleryUrls ? { galleryUrls } : {}),
        ...(videoUrl ? { redditVideoUrl: videoUrl } : {}),
      },
    };
  }

  if (child.kind === 't1') {
    const sourceUrl = toAbsoluteRedditUrl(data.link_permalink) || toAbsoluteRedditUrl(data.permalink);
    if (!sourceUrl) return null;
    const subreddit = typeof data.subreddit_name_prefixed === 'string' ? data.subreddit_name_prefixed : 'Reddit';

    return {
      sourcePlatform: 'reddit',
      sourceId,
      sourceUrl,
      canonicalUrl: sourceUrl,
      title: `Comment in ${subreddit}`,
      description: typeof data.body === 'string' ? data.body : undefined,
      capturedAt: toIsoFromUnix(data.created_utc),
      rawMetadata: {
        subreddit: data.subreddit,
        subredditNamePrefixed: data.subreddit_name_prefixed,
        author: data.author,
        score: data.score,
        linkTitle: data.link_title,
        permalink: toAbsoluteRedditUrl(data.permalink),
        kind: child.kind,
        importedVia: 'browser_extension_bulk_import',
      },
    };
  }

  return null;
}

async function runRedditImport() {
  const { reportProgress, sendBatch } = window.MCImportCommon;
  const username = await extractRedditUsername();

  if (!username) {
    reportProgress('reddit', { done: true, error: 'Could not determine your Reddit username. Please navigate to reddit.com/user/<you>/saved and try again.' });
    return;
  }

  let after;
  let page = 0;
  let totalImported = 0;
  let totalSkipped = 0;
  const errors = [];

  while (page < REDDIT_MAX_PAGES) {
    const url = new URL(`https://www.reddit.com/user/${username}/saved.json`);
    url.searchParams.set('raw_json', '1');
    url.searchParams.set('limit', String(REDDIT_PAGE_SIZE));
    if (after) url.searchParams.set('after', after);

    let response;
    try {
      response = await fetch(url.toString(), { credentials: 'include' });
    } catch (err) {
      errors.push(err.message || 'Network error fetching Reddit saved items');
      break;
    }

    if (!response.ok) {
      errors.push(`Reddit saved.json request failed: ${response.status} ${response.statusText}`);
      break;
    }

    const payload = await response.json();
    const children = Array.isArray(payload?.data?.children) ? payload.data.children : [];
    const normalized = children.map(normalizeRedditChild).filter(Boolean);

    for (let i = 0; i < normalized.length; i += REDDIT_BATCH_SIZE) {
      const batch = normalized.slice(i, i + REDDIT_BATCH_SIZE);
      try {
        const result = await sendBatch('reddit', batch);
        totalImported += result.imported;
        totalSkipped += result.skipped;
        if (result.errors?.length) errors.push(...result.errors);
      } catch (err) {
        errors.push(err.message || 'Failed to submit batch');
      }
      reportProgress('reddit', { imported: totalImported, skipped: totalSkipped, done: false });
    }

    page += 1;
    after = payload?.data?.after || null;
    if (!after) break;
  }

  reportProgress('reddit', { imported: totalImported, skipped: totalSkipped, errors: errors.slice(0, 10), done: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mc-start-import' && message.platform === 'reddit') {
    runRedditImport();
    sendResponse({ started: true });
  }
});
