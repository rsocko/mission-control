/**
 * Social Media oEmbed Resolver for Triage Queue
 *
 * Resolves social media URLs to embeddable HTML using oEmbed APIs (TikTok, YouTube)
 * or widget-based approaches (Twitter/X). Ported from RyMessage's socialEmbedResolver.
 *
 * Used by the embed-resolver to produce richer embeds for supported platforms.
 */

export type SocialPlatform = 'tiktok' | 'youtube' | 'twitter' | 'instagram';

export interface SocialEmbedResult {
  platform: SocialPlatform;
  html: string;
  title?: string;
  authorName?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

// ── URL Pattern Detection ────────────────────────────────────────────────────

const TIKTOK_URL_RE = /^https?:\/\/(?:(?:www|m)\.)?tiktok\.com\/@[\w.-]+\/(?:video|photo)\/(\d+)/i;
const TIKTOK_SHORT_RE = /^https?:\/\/(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9]+\/?/i;
const TIKTOK_WEB_SHORT_RE = /^https?:\/\/(?:www\.)?tiktok\.com\/t\/[A-Za-z0-9]+\/?/i;

const YOUTUBE_URL_RE = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?.*v=([\w-]{11})/i;
const YOUTUBE_SHORT_RE = /^https?:\/\/youtu\.be\/([\w-]{11})/i;
const YOUTUBE_SHORTS_RE = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]{11})/i;
const YOUTUBE_EMBED_RE = /^https?:\/\/(?:www\.)?youtube\.com\/embed\/([\w-]{11})/i;

const TWITTER_STATUS_RE = /^https?:\/\/(?:(?:www|mobile)\.)?(?:twitter\.com|x\.com)\/(?:i\/(?:web\/)?status|[A-Za-z0-9_]{1,15}\/status)\/(\d+)/i;

const INSTAGRAM_POST_RE = /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

/**
 * Detects whether a URL is from a supported social media platform.
 */
export function detectSocialPlatform(url: string): SocialPlatform | null {
  if (TIKTOK_URL_RE.test(url) || TIKTOK_SHORT_RE.test(url) || TIKTOK_WEB_SHORT_RE.test(url)) {
    return 'tiktok';
  }
  if (YOUTUBE_URL_RE.test(url) || YOUTUBE_SHORT_RE.test(url) || YOUTUBE_SHORTS_RE.test(url) || YOUTUBE_EMBED_RE.test(url)) {
    return 'youtube';
  }
  if (TWITTER_STATUS_RE.test(url)) {
    return 'twitter';
  }
  if (INSTAGRAM_POST_RE.test(url)) {
    return 'instagram';
  }
  return null;
}

// ── oEmbed Fetchers ──────────────────────────────────────────────────────────

interface OEmbedResponse {
  html?: string;
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  width?: number;
  height?: number;
}

const OEMBED_TIMEOUT_MS = 8000;

async function fetchTikTokEmbed(url: string, signal?: AbortSignal): Promise<SocialEmbedResult> {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { signal });
  if (!response.ok) {
    throw new Error(`TikTok oEmbed failed: ${response.status}`);
  }
  const data: OEmbedResponse = await response.json();
  // TikTok oEmbed returns blockquote+script HTML which won't work via innerHTML.
  // Instead, construct a safe iframe embed using the TikTok embed endpoint.
  // Extract video ID from the URL for the iframe src.
  const videoIdMatch = url.match(/\/video\/(\d+)/i) || url.match(/\/photo\/(\d+)/i);
  let embedHtml: string;
  if (videoIdMatch?.[1]) {
    embedHtml = `<iframe src="https://www.tiktok.com/embed/v2/${encodeURIComponent(videoIdMatch[1])}" width="325" height="580" frameborder="0" allowfullscreen loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" referrerpolicy="no-referrer" style="max-width:100%;border-radius:12px;"></iframe>`;
  } else {
    // For short URLs where we can't extract the ID, use the oEmbed HTML sanitized
    // (strip script tags, keep only safe elements)
    embedHtml = data.html ? stripScriptTags(data.html) : '';
  }
  if (!embedHtml) {
    throw new Error('TikTok oEmbed: could not construct safe embed');
  }
  return {
    platform: 'tiktok',
    html: embedHtml,
    title: data.title,
    authorName: data.author_name,
    thumbnailUrl: data.thumbnail_url,
    width: data.width,
    height: data.height,
  };
}

async function fetchYouTubeEmbed(url: string, signal?: AbortSignal): Promise<SocialEmbedResult> {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const response = await fetch(endpoint, { signal });
  if (!response.ok) {
    throw new Error(`YouTube oEmbed failed: ${response.status}`);
  }
  const data: OEmbedResponse = await response.json();
  if (!data.html) {
    throw new Error('YouTube oEmbed returned no HTML');
  }
  return {
    platform: 'youtube',
    html: data.html,
    title: data.title,
    authorName: data.author_name,
    thumbnailUrl: data.thumbnail_url,
    width: data.width ?? 480,
    height: data.height ?? 270,
  };
}

function buildTwitterWidgetHtml(url: string): SocialEmbedResult {
  // Use Twitter's iframe-based embed endpoint — no script injection needed
  const statusMatch = url.match(TWITTER_STATUS_RE);
  const tweetId = statusMatch?.[1];
  if (!tweetId) {
    // Fallback: can't extract tweet ID, construct a safe link
    const safeUrl = escapeHtml(url);
    return { platform: 'twitter', html: `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">View on X</a>` };
  }
  const html = `<iframe src="https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(tweetId)}&theme=dark" width="550" height="450" frameborder="0" allowfullscreen loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" referrerpolicy="no-referrer" style="max-width:100%;border-radius:12px;"></iframe>`;
  return {
    platform: 'twitter',
    html,
  };
}

async function buildInstagramEmbed(url: string, signal?: AbortSignal): Promise<SocialEmbedResult> {
  // Use Instagram's iframe embed endpoint — no script injection needed
  const postMatch = url.match(INSTAGRAM_POST_RE);
  const shortcode = postMatch?.[1];
  if (!shortcode) {
    const safeUrl = escapeHtml(url);
    return { platform: 'instagram', html: `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">View on Instagram</a>` };
  }
  // Use the correct embed path prefix based on content type (reel vs post/tv)
  const isReel = /\/reels?\//.test(url);
  const embedPrefix = isReel ? 'reel' : 'p';
  const html = `<iframe src="https://www.instagram.com/${embedPrefix}/${encodeURIComponent(shortcode)}/embed/?captioned=false" width="100%" height="100%" frameborder="0" allowfullscreen loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" style="max-width:100%;max-height:100%;border:0;border-radius:12px;"></iframe>`;

  // Try Instagram's public oEmbed endpoint to get a thumbnail URL
  let thumbnailUrl: string | undefined;
  let title: string | undefined;
  let authorName: string | undefined;
  try {
    const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}&maxwidth=640&omitscript=true`;
    const response = await fetch(oembedUrl, { signal });
    if (response.ok) {
      const data: OEmbedResponse = await response.json();
      thumbnailUrl = data.thumbnail_url;
      title = data.title;
      authorName = data.author_name;
    }
  } catch {
    // oEmbed may require auth or fail — continue without thumbnail
  }

  return {
    platform: 'instagram',
    html,
    thumbnailUrl,
    title,
    authorName,
  };
}

// ── Main Resolver ────────────────────────────────────────────────────────────

export interface ResolveSocialEmbedOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Resolves a social media URL to embeddable HTML.
 * Returns null if the URL is not from a supported platform or the fetch fails.
 */
export async function resolveSocialEmbed(
  url: string,
  options?: ResolveSocialEmbedOptions,
): Promise<SocialEmbedResult | null> {
  const platform = detectSocialPlatform(url);
  if (!platform) {
    return null;
  }

  const timeoutMs = options?.timeoutMs ?? OEMBED_TIMEOUT_MS;
  const controller = new AbortController();
  const externalSignal = options?.signal;

  if (externalSignal?.aborted) {
    return null;
  }

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);

  try {
    switch (platform) {
      case 'tiktok':
        return await fetchTikTokEmbed(url, controller.signal);
      case 'youtube':
        return await fetchYouTubeEmbed(url, controller.signal);
      case 'twitter':
        return buildTwitterWidgetHtml(url);
      case 'instagram':
        return await buildInstagramEmbed(url, controller.signal);
      default:
        return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strips <script> tags from HTML to prevent execution in innerHTML contexts */
function stripScriptTags(html: string): string {
  return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
}
