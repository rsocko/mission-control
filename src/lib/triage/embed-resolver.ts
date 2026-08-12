/**
 * Embed resolver — resolves oEmbed/OpenGraph metadata for triage items.
 *
 * Uses metascraper to fetch and parse HTML, extracting title, description,
 * thumbnail, video, iframe embed HTML, and provider information.
 *
 * Result is stored in rawMetadata.embed following the EmbedMetadata interface
 * from TRIAGE-QUEUE-DESIGN.md.
 */

import createMetascraper from 'metascraper';
import metascraperTitle from 'metascraper-title';
import metascraperDescription from 'metascraper-description';
import metascraperImage from 'metascraper-image';
import metascraperVideo from 'metascraper-video';
import metascraperUrl from 'metascraper-url';
import metascraperLogo from 'metascraper-logo';
import metascraperAuthor from 'metascraper-author';
import metascraperPublisher from 'metascraper-publisher';
import metascraperIframe from 'metascraper-iframe';
import { detectSocialPlatform, resolveSocialEmbed } from './social-embed-resolver';
import { isLikelyChallengePage } from './challenge-detector';
import { DomainRateLimiter } from './domain-rate-limiter';
import { decodeUtf8, INGESTION_LIMITS } from '@/lib/ingestion/bounded-reader';
import { fetchBounded } from '@/lib/ingestion/bounded-fetch';

const domainRateLimiter = new DomainRateLimiter();

// ─── Types ───────────────────────────────────────────────────────────────────

/** Matches the EmbedMetadata interface from TRIAGE-QUEUE-DESIGN.md §Level 1b */
export interface EmbedMetadata {
  type: 'video' | 'rich' | 'photo' | 'link';
  provider_name: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  html?: string;
  aspect_ratio?: number;
  media_urls?: string[];
  duration_seconds?: number;

  // Extended fields from metascraper
  resolved_title?: string;
  resolved_description?: string;
  author?: string;
  logo_url?: string;
  resolved_url?: string;
  resolved_at: string;
}

export interface EmbedResolveResult {
  success: boolean;
  embed?: EmbedMetadata;
  error?: string;
}

// ─── Singleton metascraper instance ──────────────────────────────────────────

let _metascraper: ReturnType<typeof createMetascraper> | null = null;

function getMetascraper() {
  if (!_metascraper) {
    _metascraper = createMetascraper({
      rules: [
        metascraperTitle(),
        metascraperDescription(),
        metascraperImage(),
        metascraperVideo(),
        metascraperUrl(),
        metascraperLogo(),
        metascraperAuthor(),
        metascraperPublisher(),
        metascraperIframe(),
      ],
    });
  }
  return _metascraper;
}

// ─── Provider detection ──────────────────────────────────────────────────────

const PROVIDER_MAP: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /youtube\.com|youtu\.be/i, name: 'YouTube' },
  { pattern: /instagram\.com/i, name: 'Instagram' },
  { pattern: /reddit\.com/i, name: 'Reddit' },
  { pattern: /github\.com/i, name: 'GitHub' },
  { pattern: /twitter\.com|x\.com/i, name: 'X' },
  { pattern: /tiktok\.com/i, name: 'TikTok' },
  { pattern: /vimeo\.com/i, name: 'Vimeo' },
  { pattern: /printables\.com/i, name: 'Printables' },
  { pattern: /makerworld\.com/i, name: 'MakerWorld' },
  { pattern: /thingiverse\.com/i, name: 'Thingiverse' },
  { pattern: /amazon\.com|amzn\.to/i, name: 'Amazon' },
];

function detectProvider(url: string, publisher?: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const { pattern, name } of PROVIDER_MAP) {
      if (pattern.test(hostname)) return name;
    }
  } catch { /* fall through */ }
  return publisher || (() => { try { return new URL(url).hostname.replace('www.', ''); } catch { return 'Unknown'; } })();
}

// ─── Embed type classification ───────────────────────────────────────────────

function classifyEmbedType(url: string, meta: { video?: string; iframe?: string; image?: string }): EmbedMetadata['type'] {
  if (meta.video || meta.iframe) {
    if (/youtube|youtu\.be|vimeo|tiktok|instagram.*reel/i.test(url)) return 'video';
    // Instagram non-reel embeds are rich (photo + text)
    if (/instagram\.com/i.test(url)) return 'rich';
    return 'rich';
  }
  if (meta.image) {
    if (/\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i.test(meta.image)) return 'photo';
    return 'photo';
  }
  return 'link';
}

// ─── SSRF protection ─────────────────────────────────────────────────────────

/** Block fetches to private/internal network addresses */
function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Block loopback
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname === '[::1]') return true;

    // Block link-local, private ranges, cloud metadata
    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return true;                          // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
      if (a === 192 && b === 168) return true;             // 192.168.0.0/16
      if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local + cloud metadata)
      if (a === 0) return true;                            // 0.0.0.0/8
    }

    // Block non-HTTP(S) protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

    return false;
  } catch {
    return true; // Block malformed URLs
  }
}

// ─── Embed HTML sanitization ─────────────────────────────────────────────────

/** Trusted iframe src domains for embed HTML */
const TRUSTED_EMBED_DOMAINS = new Set([
  'youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'player.vimeo.com', 'vimeo.com',
  'www.instagram.com', 'instagram.com',
  'platform.twitter.com', 'twitter.com', 'x.com',
  'www.tiktok.com', 'tiktok.com',
  'open.spotify.com',
  'w.soundcloud.com',
  'codepen.io',
  'codesandbox.io',
]);

/**
 * Sanitize embed HTML — only allow <iframe> tags with src pointing to trusted domains.
 * Strips all other HTML, script tags, event handlers, etc.
 */
function sanitizeEmbedHtml(html: string): string | undefined {
  // Extract iframe src from the HTML
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (!iframeMatch?.[1]) return undefined;

  const src = iframeMatch[1];
  try {
    const srcUrl = new URL(src);
    const hostname = srcUrl.hostname.toLowerCase();

    // Check if hostname is in trusted list (or is a subdomain of a trusted domain)
    const isTrusted = TRUSTED_EMBED_DOMAINS.has(hostname) ||
      Array.from(TRUSTED_EMBED_DOMAINS).some((d) => hostname.endsWith(`.${d}`));

    if (!isTrusted) return undefined;
    if (srcUrl.protocol !== 'https:') return undefined;

    // Rebuild a clean iframe with only safe attributes
    return `<iframe src="${srcUrl.href}" width="560" height="315" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`;
  } catch {
    return undefined;
  }
}

// ─── YouTube helpers ─────────────────────────────────────────────────────────

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function extractYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1] && YOUTUBE_ID_RE.test(match[1])) return match[1];
  }
  return null;
}

function buildYouTubeEmbed(videoId: string): string {
  if (!YOUTUBE_ID_RE.test(videoId)) return '';
  return `<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" referrerpolicy="no-referrer"></iframe>`;
}

// ─── Main resolver ───────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = 'mission-control-embed-resolver/1.0 (compatible; metascraper)';

export async function resolveEmbed(url: string): Promise<EmbedResolveResult> {
  try {
    new URL(url); // validate
  } catch {
    return { success: false, error: 'Invalid URL' };
  }

  // SSRF protection — block private/internal network addresses
  if (isPrivateUrl(url)) {
    return { success: false, error: 'URL points to a private or internal network address' };
  }

  // Try social oEmbed first for supported platforms (TikTok, Twitter, Instagram)
  // YouTube is handled below via metascraper + custom YouTube logic for richer data
  const socialPlatform = detectSocialPlatform(url);
  if (socialPlatform && socialPlatform !== 'youtube') {
    try {
      const socialResult = await resolveSocialEmbed(url, { timeoutMs: FETCH_TIMEOUT_MS });
      if (socialResult) {
        const provider = detectProvider(url);
        // Sanitize the embed HTML — only allow iframes from trusted domains
        const sanitizedHtml = sanitizeEmbedHtml(socialResult.html) || socialResult.html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        const embed: EmbedMetadata = {
          type: socialPlatform === 'twitter' || socialPlatform === 'instagram' ? 'rich' : 'video',
          provider_name: provider,
          thumbnail_url: socialResult.thumbnailUrl,
          thumbnail_width: socialResult.width,
          thumbnail_height: socialResult.height,
          html: sanitizedHtml || undefined,
          resolved_title: socialResult.title,
          author: socialResult.authorName,
          resolved_at: new Date().toISOString(),
        };
        if (socialPlatform === 'tiktok') {
          embed.aspect_ratio = 9 / 16; // vertical video
        }
        return { success: true, embed };
      }
    } catch {
      // Fall through to metascraper if social oEmbed fails
    }
  }

  try {
    // Rate-limit outbound fetches per domain
    const hostname = new URL(url).hostname;
    await domainRateLimiter.waitForSlot(hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let html: string;
    try {
      const result = await fetchBounded(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: controller.signal,
        limit: INGESTION_LIMITS.embedHtmlBytes,
        timeoutMs: FETCH_TIMEOUT_MS,
        acceptContentTypes: /^text\/html|^application\/xhtml\+xml/i,
        label: 'Embed HTML',
        source: 'embed-html',
      });
      html = decodeUtf8(result.bytes);
    } finally {
      clearTimeout(timeout);
    }

    // Detect challenge/bot-wall pages before parsing metadata
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const pageTitle = titleMatch?.[1] || undefined;
    if (isLikelyChallengePage({ title: pageTitle, html })) {
      return { success: false, error: 'Challenge page detected (bot wall)' };
    }

    const metascraper = getMetascraper();
    const meta = await metascraper({ html, url });

    const provider = detectProvider(url, meta.publisher);
    const embedType = classifyEmbedType(url, meta);

    // Build embed HTML — prefer metascraper iframe, fall back to platform-specific
    // All embed HTML is sanitized to only allow <iframe> from trusted domains
    let embedHtml: string | undefined;
    if (meta.iframe) {
      embedHtml = sanitizeEmbedHtml(meta.iframe);
    }
    if (!embedHtml) {
      const ytId = extractYouTubeVideoId(url);
      if (ytId) embedHtml = buildYouTubeEmbed(ytId) || undefined;
    }

    // Build thumbnail — prefer metascraper image, fall back to YouTube maxres
    let thumbnailUrl = meta.image;
    if (!thumbnailUrl) {
      const ytId = extractYouTubeVideoId(url);
      if (ytId) thumbnailUrl = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
    }

    // Extract media URLs from meta
    const mediaUrls: string[] = [];
    if (meta.image) mediaUrls.push(meta.image);
    if (meta.video && meta.video !== meta.image) mediaUrls.push(meta.video);

    const embed: EmbedMetadata = {
      type: embedType,
      provider_name: provider,
      thumbnail_url: thumbnailUrl,
      html: embedHtml,
      media_urls: mediaUrls.length > 0 ? mediaUrls : undefined,
      resolved_title: meta.title,
      resolved_description: meta.description,
      author: meta.author,
      logo_url: meta.logo,
      resolved_url: meta.url || url,
      resolved_at: new Date().toISOString(),
    };

    // Set aspect ratio for known video platforms
    if (embedType === 'video') {
      embed.aspect_ratio = 16 / 9;
    }

    return { success: true, embed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Don't treat aborted fetches as hard errors
    if (message.includes('abort')) {
      return { success: false, error: 'Request timed out' };
    }
    return { success: false, error: message };
  }
}

// ─── Batch resolver for backfill ─────────────────────────────────────────────

export interface BackfillProgress {
  total: number;
  resolved: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export async function resolveEmbedBatch(
  items: Array<{ id: string; url: string; hasEmbed: boolean }>,
  onProgress?: (progress: BackfillProgress) => void,
): Promise<BackfillProgress> {
  const progress: BackfillProgress = {
    total: items.length,
    resolved: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  for (const item of items) {
    if (item.hasEmbed) {
      progress.skipped++;
      onProgress?.(progress);
      continue;
    }

    const result = await resolveEmbed(item.url);
    if (result.success) {
      progress.resolved++;
    } else {
      progress.failed++;
      if (result.error) {
        progress.errors.push(`${item.id}: ${result.error}`);
      }
    }
    onProgress?.(progress);

    // Small delay between requests to be polite
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return progress;
}
