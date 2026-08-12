/**
 * Mission Control — Save to Triage (Content Script)
 *
 * Runs on every page and extracts lightweight metadata (title, Open Graph
 * tags, canonical URL) on demand. For known platforms (Reddit, YouTube,
 * Instagram, Twitter/X, TikTok, Pinterest) it also extracts richer
 * platform-specific metadata (author, subreddit, channel, etc.).
 */

function getMeta(property) {
  const el = document.querySelector(`meta[property='${property}']`) ||
    document.querySelector(`meta[name='${property}']`);
  return el?.getAttribute('content') || undefined;
}

function getJsonLdBlocks() {
  return Array.from(document.querySelectorAll("script[type='application/ld+json']"))
    .flatMap((script) => {
      const raw = script.textContent?.trim();
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    })
    .filter(Boolean);
}

function toAbsoluteUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value, window.location.href).href;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value) {
  if (typeof value !== 'string' || !value) return null;
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&#x27;/gi, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.startsWith('data:')) return null;
  const decoded = decodeHtmlEntities(value) || value;
  return toAbsoluteUrl(decoded);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function getImageUrlFromElement(el) {
  if (!el) return null;
  const srcset = el.getAttribute?.('srcset') || '';
  if (srcset) {
    const candidate = srcset.split(',').pop()?.trim().split(/\s+/)[0];
    const normalized = normalizeMediaUrl(candidate);
    if (normalized) return normalized;
  }
  return normalizeMediaUrl(
    el.currentSrc ||
    el.src ||
    el.getAttribute?.('src') ||
    el.getAttribute?.('data-src') ||
    el.getAttribute?.('data-lazy-src'),
  );
}

function collectJsonLdImages(node, images = []) {
  if (!node) return images;
  if (typeof node === 'string') {
    const normalized = normalizeMediaUrl(node);
    if (normalized) images.push(normalized);
    return images;
  }
  if (Array.isArray(node)) {
    for (const entry of node) collectJsonLdImages(entry, images);
    return images;
  }
  if (typeof node !== 'object') return images;

  collectJsonLdImages(node.image, images);
  collectJsonLdImages(node.thumbnailUrl, images);
  collectJsonLdImages(node.contentUrl, images);

  return images;
}

function extractJsonLdAuthor() {
  for (const block of getJsonLdBlocks()) {
    const author = block?.author;
    if (typeof author === 'string' && author.trim()) return author.trim();
    if (Array.isArray(author)) {
      const authorName = author.find((entry) => typeof entry?.name === 'string' && entry.name.trim())?.name;
      if (authorName) return authorName.trim();
    }
    if (author && typeof author === 'object' && typeof author.name === 'string' && author.name.trim()) {
      return author.name.trim();
    }
  }
  return undefined;
}

function extractJsonLdPublishedAt() {
  for (const block of getJsonLdBlocks()) {
    if (typeof block?.datePublished === 'string' && block.datePublished.trim()) {
      return block.datePublished.trim();
    }
  }
  return undefined;
}

function scoreImageElement(el) {
  const width = Number(el.getAttribute?.('width') || el.naturalWidth || el.width || 0);
  const height = Number(el.getAttribute?.('height') || el.naturalHeight || el.height || 0);
  const area = width * height;
  const alt = (el.getAttribute?.('alt') || '').toLowerCase();
  let score = area;
  if (width < 160 || height < 160) score -= 100000;
  if (/(avatar|icon|emoji|logo|award|sprite)/.test(alt)) score -= 100000;
  return score;
}

function extractDomImageUrls() {
  const seen = new Map();
  const elements = Array.from(document.querySelectorAll('main img, article img, img'));
  for (const el of elements) {
    const url = getImageUrlFromElement(el);
    if (!url) continue;
    if (/(avatar|icon|emoji|logo|award|sprite)/i.test(url)) continue;
    const score = scoreImageElement(el);
    const current = seen.get(url) ?? Number.NEGATIVE_INFINITY;
    if (score > current) seen.set(url, score);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url);
}

function extractBestVideoUrl() {
  return normalizeMediaUrl(
    getMeta('og:video:secure_url') ||
    getMeta('og:video:url') ||
    getMeta('og:video') ||
    getMeta('twitter:player:stream') ||
    document.querySelector('video source')?.src ||
    document.querySelector('video')?.currentSrc ||
    document.querySelector('video')?.src,
  ) || undefined;
}

function extractCommonRichMeta() {
  const jsonLdImages = uniq(getJsonLdBlocks().flatMap((block) => collectJsonLdImages(block)));
  const domImages = extractDomImageUrls();
  const thumbnailUrl = normalizeMediaUrl(
    getMeta('og:image:secure_url') ||
    getMeta('og:image:url') ||
    getMeta('og:image') ||
    getMeta('twitter:image:src') ||
    getMeta('twitter:image') ||
    document.querySelector("link[rel='image_src']")?.href,
  ) || jsonLdImages[0] || domImages[0] || undefined;
  const galleryUrls = uniq([
    ...(thumbnailUrl ? [thumbnailUrl] : []),
    ...jsonLdImages,
    ...domImages,
  ]);
  const videoUrl = extractBestVideoUrl();
  const author = getMeta('author') || getMeta('article:author') || extractJsonLdAuthor();
  const publishedAt = getMeta('article:published_time') || extractJsonLdPublishedAt();

  return {
    ...(thumbnailUrl && { thumbnailUrl }),
    ...(galleryUrls.length > 1 && { galleryUrls }),
    ...(videoUrl && { videoUrl }),
    ...(author && { author }),
    ...(publishedAt && { publishedAt }),
  };
}

// ─── Platform detection ──────────────────────────────────────────────────────

const PLATFORM_DETECTORS = [
  { id: 'reddit', match: (h) => h.includes('reddit.com') },
  { id: 'youtube', match: (h) => h.includes('youtube.com') || h.includes('youtu.be') },
  { id: 'instagram', match: (h) => h.includes('instagram.com') },
  { id: 'twitter', match: (h) => h.includes('twitter.com') || h.includes('x.com') },
  { id: 'tiktok', match: (h) => h.includes('tiktok.com') },
  { id: 'pinterest', match: (h) => h.includes('pinterest.com') || h.includes('pin.it') },
  { id: 'facebook', match: (h) => h.includes('facebook.com') || h.includes('fb.watch') },
  { id: 'github', match: (h) => h.includes('github.com') },
];

function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const p of PLATFORM_DETECTORS) {
      if (p.match(hostname)) return p.id;
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Platform-specific metadata extractors ───────────────────────────────────

function extractRedditMeta() {
  const meta = {};
  // Subreddit
  const subMatch = window.location.pathname.match(/\/r\/([^/]+)/);
  if (subMatch) {
    meta.subreddit = subMatch[1];
    meta.subredditNamePrefixed = `r/${subMatch[1]}`;
  }
  // Author
  const authorEl = document.querySelector('[data-testid="post_author_link"]') ||
    document.querySelector('a[href*="/user/"]');
  if (authorEl) {
    const authorMatch = authorEl.getAttribute('href')?.match(/\/(?:user|u)\/([^/]+)/);
    if (authorMatch) meta.author = authorMatch[1];
  }
  // Score
  const scoreEl = document.querySelector('[data-testid="vote-score"]') ||
    document.querySelector('shreddit-post')?.getAttribute('score');
  if (scoreEl) {
    const score = typeof scoreEl === 'string' ? scoreEl : scoreEl.textContent;
    if (score) meta.score = score.trim();
  }
  const commonMeta = extractCommonRichMeta();
  if (commonMeta.thumbnailUrl) meta.thumbnailUrl = commonMeta.thumbnailUrl;
  if (Array.isArray(commonMeta.galleryUrls) && commonMeta.galleryUrls.length > 1) {
    meta.galleryUrls = commonMeta.galleryUrls;
  }
  const redditVideoUrl = normalizeMediaUrl(
    getMeta('og:video') ||
    getMeta('twitter:player:stream') ||
    document.querySelector('video source')?.src ||
    document.querySelector('video')?.currentSrc ||
    document.querySelector('video')?.src,
  );
  if (redditVideoUrl) meta.redditVideoUrl = redditVideoUrl;
  return meta;
}

function extractYouTubeMeta() {
  const meta = {};
  // Channel name
  const channelEl = document.querySelector('#channel-name a, ytd-channel-name a, [itemprop="author"] [itemprop="name"]');
  if (channelEl) meta.channelName = channelEl.textContent?.trim();
  // Video ID from URL
  try {
    const params = new URL(window.location.href).searchParams;
    if (params.get('v')) meta.videoId = params.get('v');
  } catch { /* ignore */ }
  // Duration
  const durationEl = document.querySelector('[itemprop="duration"]');
  if (durationEl) meta.duration = durationEl.getAttribute('content');
  return meta;
}

function extractInstagramMeta() {
  const meta = {};
  // Username from URL path
  const pathMatch = window.location.pathname.match(/^\/([A-Za-z0-9._]+)\/?/);
  const reserved = ['p', 'reel', 'reels', 'explore', 'direct', 'stories', 'accounts', 'about', 'legal'];
  if (pathMatch && !reserved.includes(pathMatch[1])) {
    meta.username = pathMatch[1];
  }
  // Post shortcode
  const postMatch = window.location.pathname.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (postMatch) meta.shortcode = postMatch[1];
  return meta;
}

function extractTwitterMeta() {
  const meta = {};
  // Username from URL
  const userMatch = window.location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?/);
  const reserved = ['home', 'explore', 'search', 'notifications', 'messages', 'settings', 'i', 'compose'];
  if (userMatch && !reserved.includes(userMatch[1])) {
    meta.username = userMatch[1];
  }
  // Tweet ID
  const statusMatch = window.location.pathname.match(/\/status\/(\d+)/);
  if (statusMatch) meta.tweetId = statusMatch[1];
  return meta;
}

function extractTikTokMeta() {
  const meta = {};
  // Username from URL
  const userMatch = window.location.pathname.match(/\/@([^/]+)/);
  if (userMatch) meta.username = userMatch[1];
  // Video ID
  const videoMatch = window.location.pathname.match(/\/video\/(\d+)/);
  if (videoMatch) meta.videoId = videoMatch[1];
  return meta;
}

function extractPinterestMeta() {
  const meta = {};
  // Pin ID
  const pinMatch = window.location.pathname.match(/\/pin\/(\d+)/);
  if (pinMatch) meta.pinId = pinMatch[1];
  // Board
  const boardMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (boardMatch && boardMatch[1] !== 'pin') {
    meta.boardOwner = boardMatch[1];
    meta.boardName = boardMatch[2];
  }
  return meta;
}

function extractGitHubMeta() {
  const meta = {};
  // Repo owner/name
  const repoMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (repoMatch) {
    meta.owner = repoMatch[1];
    meta.repo = repoMatch[2];
  }
  // Star count
  const starEl = document.querySelector('#repo-stars-counter-star, .Counter[aria-label*="star"]');
  if (starEl) meta.stars = starEl.textContent?.trim();
  // Description
  const descEl = document.querySelector('[itemprop="about"], .f4.my-3');
  if (descEl) meta.repoDescription = descEl.textContent?.trim();
  return meta;
}

const PLATFORM_EXTRACTORS = {
  reddit: extractRedditMeta,
  youtube: extractYouTubeMeta,
  instagram: extractInstagramMeta,
  twitter: extractTwitterMeta,
  tiktok: extractTikTokMeta,
  pinterest: extractPinterestMeta,
  github: extractGitHubMeta,
};

// ─── Main extraction ─────────────────────────────────────────────────────────

function extractPageMetadata() {
  const url = window.location.href;
  const platform = detectPlatform(url);
  const commonMeta = extractCommonRichMeta();

  const base = {
    url,
    title: document.title || undefined,
    canonicalUrl: document.querySelector("link[rel='canonical']")?.href || undefined,
    ogTitle: getMeta('og:title'),
    ogDescription: getMeta('og:description'),
    ogImage: getMeta('og:image'),
    ogType: getMeta('og:type'),
    ogSiteName: getMeta('og:site_name'),
    metaDescription: getMeta('description'),
    twitterTitle: getMeta('twitter:title'),
    twitterDescription: getMeta('twitter:description'),
    twitterCard: getMeta('twitter:card'),
    twitterImage: getMeta('twitter:image'),
    thumbnailUrl: commonMeta.thumbnailUrl,
    detectedPlatform: platform,
  };

  // Extract platform-specific metadata for known sources
  if (platform && PLATFORM_EXTRACTORS[platform]) {
    try {
      base.platformMeta = { ...commonMeta, ...PLATFORM_EXTRACTORS[platform]() };
    } catch { /* non-critical, skip */ }
  } else if (Object.keys(commonMeta).length > 0) {
    base.platformMeta = commonMeta;
  }

  return base;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mc-extract-page-metadata') {
    sendResponse(extractPageMetadata());
  }
  // Returning true would keep the channel open for async responses; not
  // needed here since extraction is synchronous.
});
