'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { TriageItem } from '@/types';

// ─── Types ───────────────────────────────────────────────────────────────────

type EmbedData = {
  type?: string;
  html?: string;
  thumbnail_url?: string;
  provider_name?: string;
  resolved_title?: string;
  duration_seconds?: number;
  aspect_ratio?: number;
};

interface RichPreviewEmbedProps {
  item: TriageItem;
  /** Whether to allow expanding into a full embed */
  embedsEnabled?: boolean;
  /** Layout variant */
  variant?: 'compact' | 'full' | 'inline';
  /** Max height for the thumbnail image */
  maxThumbnailHeight?: number;
  /** Auto-expand embeds instead of requiring a click (useful for detail panels) */
  autoExpand?: boolean;
  /** Class name for the container */
  className?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Patch stored embed HTML to add allow-popups-to-escape-sandbox if missing.
 * This ensures previously-resolved embeds (e.g. Instagram) can open links
 * in new tabs without ERR_BLOCKED_BY_RESPONSE errors.
 */
function patchSandboxAttr(html: string): string {
  return html.replace(
    /sandbox="([^"]*?)"/g,
    (match, attrs: string) => {
      if (attrs.includes('allow-popups-to-escape-sandbox')) return match;
      if (!attrs.includes('allow-popups')) return match;
      return `sandbox="${attrs} allow-popups-to-escape-sandbox"`;
    },
  );
}

function getYouTubeVideoId(item: TriageItem): string | null {
  const url = item.sourceUrl || '';
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];
  const meta = item.rawMetadata || {};
  if (typeof meta.videoId === 'string') return meta.videoId;
  return null;
}

function isEmbeddable(embed: EmbedData | undefined): boolean {
  if (!embed) return false;
  return !!(embed.html && (embed.type === 'video' || embed.type === 'rich'));
}

/**
 * Returns responsive aspect-ratio classes per platform.
 * Uses CSS aspect-ratio so the embed scales fluidly with panel width
 * while respecting max-height to avoid oversized embeds on large screens.
 */
function getAspectClass(embed: EmbedData | undefined, item: TriageItem): string {
  // If we have an explicit aspect_ratio from the oEmbed data, use it
  if (embed?.aspect_ratio) {
    if (embed.aspect_ratio <= 0.6) {
      // Very tall vertical (9:16 — TikTok, Reels, Shorts)
      return 'aspect-[9/16] max-h-[600px]';
    }
    if (embed.aspect_ratio < 1) {
      // Portrait (4:5 — Instagram posts, Facebook portrait)
      return 'aspect-[4/5] max-h-[600px]';
    }
    if (embed.aspect_ratio >= 1.7) {
      // Wide landscape (16:9 — YouTube, standard video)
      return 'aspect-video max-h-[400px]';
    }
    // Between 1:1 and 16:9 — near-square or 4:3
    return 'aspect-[4/3] max-h-[500px]';
  }

  // Platform-specific defaults when no aspect_ratio metadata available
  switch (item.sourcePlatform) {
    case 'instagram':
      // Instagram is predominantly 4:5 portrait
      return 'aspect-[4/5] max-h-[600px]';
    case 'tiktok':
      // TikTok is always 9:16 vertical
      return 'aspect-[9/16] max-h-[600px]';
    case 'facebook':
      // Facebook varies; default to 4:5 portrait (most common for video/images)
      return 'aspect-[4/5] max-h-[550px]';
    case 'youtube':
      // YouTube is almost always 16:9
      return 'aspect-video max-h-[400px]';
    case 'pinterest':
      // Pinterest pins are typically 2:3 portrait
      return 'aspect-[2/3] max-h-[550px]';
    case 'twitter':
      // Twitter cards are roughly 16:9
      return 'aspect-video max-h-[400px]';
    default:
      return 'aspect-video max-h-[400px]';
  }
}

function getPlatformAccent(platform: string): string {
  switch (platform) {
    case 'youtube': return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'tiktok': return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300';
    case 'twitter': return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
    case 'instagram': return 'border-pink-500/30 bg-pink-500/10 text-pink-300';
    default: return 'border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent-300)]';
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Multi-layer preview component for triage items:
 * - Layer 1: Always shows thumbnail image (from thumbnailUrl or embed.thumbnail_url)
 * - Layer 2: Click-to-expand into full embed (iframe/widget) when available
 *
 * Supports YouTube (hover-to-play iframe), TikTok (oEmbed widget), Twitter/X (widget.js),
 * Instagram (embed.js), and any other platform with embed HTML in rawMetadata.embed.
 */
export default function RichPreviewEmbed({
  item,
  embedsEnabled = true,
  variant = 'full',
  maxThumbnailHeight = 420,
  autoExpand = false,
  className,
}: RichPreviewEmbedProps) {
  const embed = item.rawMetadata?.embed as EmbedData | undefined;
  const thumbnailUrl = item.thumbnailUrl || embed?.thumbnail_url;
  const [expanded, setExpanded] = useState(autoExpand);
  const [hoverPlay, setHoverPlay] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLDivElement>(null);

  const youtubeId = getYouTubeVideoId(item);
  const canEmbed = embedsEnabled && isEmbeddable(embed);
  const canYouTubeHover = embedsEnabled && !!youtubeId && !expanded;
  const isRich = embed?.type === 'rich';

  // Reddit video: mp4/video URL stored during import
  const redditVideoUrl = (item.rawMetadata?.redditVideoUrl as string | undefined) || null;
  const hasRedditVideo = !!redditVideoUrl;

  const isVideo = item.contentType === 'video' || embed?.type === 'video' || !!youtubeId || hasRedditVideo;

  // Gallery carousel: multiple images from Reddit galleries or similar
  const galleryUrls = (item.rawMetadata?.galleryUrls as string[] | undefined) || null;
  const hasGallery = Array.isArray(galleryUrls) && galleryUrls.length > 1;

  // Instagram: extract shortcode and content type for inline embed fallback
  const isInstagram = item.sourcePlatform === 'instagram';
  const instagramUrl = isInstagram ? (item.sourceUrl || item.canonicalUrl || '') : '';
  const instagramShortcode = isInstagram
    ? instagramUrl.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] || null
    : null;
  const instagramIsReel = isInstagram && /\/reels?\//.test(instagramUrl);
  const instagramEmbedPrefix = instagramIsReel ? 'reel' : 'p';

  // Auto-expand Instagram embeds when no valid thumbnail is available,
  // OR when autoExpand is set (e.g. in the detail panel)
  const autoExpandInstagram = isInstagram && (canEmbed || !!instagramShortcode) &&
    ((!thumbnailUrl || thumbFailed) || autoExpand);

  // Reset state when the item changes to prevent state leakage between items
  useEffect(() => {
    setExpanded(autoExpand);
    setHoverPlay(false);
    setThumbFailed(false);
    setGalleryIndex(0);
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, [item.id, autoExpand]);

  // Cleanup hover timer on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (!canYouTubeHover) return;
    hoverTimerRef.current = setTimeout(() => setHoverPlay(true), 400);
  }, [canYouTubeHover]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverPlay(false);
  }, []);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(true);
  }, []);

  const handleCollapseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(false);
    setHoverPlay(false);
  }, []);

  // No thumbnail and no embed and not Instagram and no gallery and no Reddit video — nothing to render
  if (!thumbnailUrl && !canEmbed && !youtubeId && !instagramShortcode && !hasGallery && !hasRedditVideo) return null;

  // ─── Reddit video (mp4 from v.redd.it or preview variants) ──────────────────
  if (hasRedditVideo && (expanded || autoExpand)) {
    return (
      <div className={cn('relative overflow-hidden rounded-[12px] bg-black', className)}>
        {!autoExpand && (
          <button
            type="button"
            onClick={handleCollapseClick}
            className="absolute right-2 top-2 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
            title="Collapse preview"
          >
            <X size={14} />
          </button>
        )}
        <video
          src={redditVideoUrl}
          className="w-full object-contain"
          style={{ maxHeight: variant === 'compact' ? 200 : maxThumbnailHeight }}
          autoPlay
          loop
          muted
          playsInline
          controls
        />
      </div>
    );
  }

  // ─── Gallery carousel (Reddit multi-image posts) ────────────────────────────
  if (hasGallery && !expanded) {
    const safeIndex = Math.min(galleryIndex, galleryUrls.length - 1);
    return (
      <div className={cn('group/preview relative overflow-hidden rounded-[12px] bg-[var(--surface-2)]', className)}>
        <img
          src={galleryUrls[safeIndex]}
          alt=""
          className="w-full object-contain"
          style={{ maxHeight: variant === 'compact' ? 200 : maxThumbnailHeight }}
          loading="lazy"
        />
        {/* Navigation arrows */}
        {safeIndex > 0 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setGalleryIndex(safeIndex - 1); }}
            className="absolute left-2 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
            title="Previous image"
          >
            <ChevronLeft size={14} />
          </button>
        )}
        {safeIndex < galleryUrls.length - 1 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setGalleryIndex(safeIndex + 1); }}
            className="absolute right-2 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
            title="Next image"
          >
            <ChevronRight size={14} />
          </button>
        )}
        {/* Dot indicators */}
        <div className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 gap-1">
          {galleryUrls.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => { e.stopPropagation(); setGalleryIndex(i); }}
              className={cn(
                'h-1.5 rounded-full transition-[width,background-color]',
                i === safeIndex ? 'w-3 bg-white' : 'w-1.5 bg-white/50',
              )}
            />
          ))}
        </div>
        {/* Counter badge */}
        <span className="absolute right-2 top-2 z-10 rounded-[4px] bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white backdrop-blur-sm [font-variant-numeric:tabular-nums]">
          {safeIndex + 1} / {galleryUrls.length}
        </span>
      </div>
    );
  }

  // ─── Auto-expanded Instagram embed (no thumbnail available) ─────────────────
  if (autoExpandInstagram) {
    const embedHtml = embed?.html;
    const iframeSrc = instagramShortcode
      ? `https://www.instagram.com/${instagramEmbedPrefix}/${instagramShortcode}/embed/`
      : null;

    return (
      <div className={cn('relative overflow-hidden rounded-[12px] border border-[var(--border)] bg-black', className)}>
        {embed?.provider_name && (
          <div className={cn('absolute left-2 top-2 z-20 rounded-[4px] border px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider', getPlatformAccent(item.sourcePlatform))}>
            {embed.provider_name}
          </div>
        )}
        {embedHtml ? (
          <div
            ref={iframeRef}
            className={cn(
              'flex w-full justify-center overflow-hidden [&_iframe]:!h-full [&_iframe]:!w-full [&_iframe]:!max-w-full [&>*]:!max-w-full [&>*]:!w-full',
              getAspectClass(embed, item),
            )}
            dangerouslySetInnerHTML={{ __html: patchSandboxAttr(embedHtml) }}
          />
        ) : iframeSrc ? (
          <div className={cn('w-full overflow-hidden', getAspectClass(embed, item))}>
            <iframe
              src={`${iframeSrc}?captioned=true`}
              className="h-full w-full border-0"
              loading="lazy"
              title="Instagram preview"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : null}
      </div>
    );
  }

  // ─── Expanded state: show full embed ────────────────────────────────────────
  if (expanded && canEmbed && embed?.html) {
    return (
      <div className={cn('relative overflow-hidden rounded-[12px] border border-[var(--border)] bg-black', className)}>
        {/* Collapse button */}
        <button
          type="button"
          onClick={handleCollapseClick}
          className="absolute right-2 top-2 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
          title="Collapse preview"
        >
          <X size={14} />
        </button>

        {/* Platform label */}
        {embed.provider_name && (
          <div className={cn('absolute left-2 top-2 z-20 rounded-[4px] border px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider', getPlatformAccent(item.sourcePlatform))}>
            {embed.provider_name}
          </div>
        )}

        <div
          ref={iframeRef}
          className={cn('w-full overflow-hidden', getAspectClass(embed, item))}
          dangerouslySetInnerHTML={{ __html: patchSandboxAttr(embed.html) }}
        />
      </div>
    );
  }

  // ─── Expanded state: Instagram iframe embed ──────────────────────────────────
  if (expanded && instagramShortcode && !canEmbed) {
    return (
      <div className={cn('relative overflow-hidden rounded-[12px] border border-[var(--border)] bg-black', className)}>
        <button
          type="button"
          onClick={handleCollapseClick}
          className="absolute right-2 top-2 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
          title="Collapse preview"
        >
          <X size={14} />
        </button>
        <span className={cn('absolute left-2 top-2 z-20 rounded-[4px] border px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider', getPlatformAccent('instagram'))}>
          Instagram
        </span>
        <div className={cn('w-full overflow-hidden', getAspectClass(embed, item))}>
          <iframe
            src={`https://www.instagram.com/${instagramEmbedPrefix}/${instagramShortcode}/embed/?captioned=true`}
            className="h-full w-full border-0"
            loading="lazy"
            title="Instagram preview"
            referrerPolicy="no-referrer"
          />
        </div>
      </div>
    );
  }

  // ─── Expanded state: YouTube full iframe ────────────────────────────────────
  if (expanded && youtubeId) {
    return (
      <div className={cn('relative overflow-hidden rounded-[12px] border border-[var(--border)] bg-black', getAspectClass(embed, item), className)}>
        <button
          type="button"
          onClick={handleCollapseClick}
          className="absolute right-2 top-2 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
          title="Collapse preview"
        >
          <X size={14} />
        </button>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          loading="lazy"
          title={item.title}
        />
      </div>
    );
  }

  // ─── Thumbnail state (Layer 1) with play/expand overlay ─────────────────────
  const showExpandButton = canEmbed || !!youtubeId || !!instagramShortcode || hasRedditVideo;

  return (
    <div
      className={cn(
        'group/preview relative overflow-hidden rounded-[12px] bg-[var(--surface-2)]',
        variant === 'compact' && 'max-h-[200px]',
        // Maintain aspect ratio even when thumbnail is hidden during hover-to-play
        youtubeId && 'aspect-video',
        className,
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* YouTube hover-to-play */}
      {hoverPlay && youtubeId && (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&loop=1`}
          className="absolute inset-0 z-10 h-full w-full"
          allow="autoplay; encrypted-media"
          loading="lazy"
          title="Video preview"
        />
      )}

      {/* Thumbnail image */}
      {thumbnailUrl && !hoverPlay && !thumbFailed && (
        <img
          src={thumbnailUrl}
          alt=""
          className="h-full w-full object-cover"
          style={{ maxHeight: variant === 'compact' ? 200 : maxThumbnailHeight }}
          loading="lazy"
          onError={() => setThumbFailed(true)}
        />
      )}

      {/* Fallback when no thumbnail available */}
      {(!thumbnailUrl || thumbFailed) && !hoverPlay && (
        <div className="flex h-[120px] items-center justify-center">
          <Play size={32} className="text-[var(--text-tertiary)]" />
        </div>
      )}

      {/* Video play overlay (when not hovering YouTube) */}
      {isVideo && !hoverPlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10">
          <Play size={variant === 'compact' ? 24 : 36} className="text-white opacity-80 drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]" fill="white" />
        </div>
      )}

      {/* Expand/Play button */}
      {showExpandButton && embedsEnabled && !hoverPlay && (
        <button
          type="button"
          onClick={handleExpandClick}
          className={cn(
            'absolute z-20 flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-xs font-semibold backdrop-blur-sm transition-[opacity,background-color]',
            'opacity-0 group-hover/preview:opacity-100',
            variant === 'compact' ? 'bottom-1.5 right-1.5' : 'bottom-2 right-2',
            isVideo
              ? 'border-white/20 bg-black/60 text-white hover:bg-black/80'
              : cn('border-white/20 bg-black/60 text-white hover:bg-black/80', getPlatformAccent(item.sourcePlatform)),
          )}
          title={isVideo ? 'Play video' : 'Expand embed'}
        >
          {isVideo ? <Play size={10} fill="currentColor" /> : <Maximize2 size={10} />}
          {isVideo ? 'Play' : isRich ? 'Expand' : 'Preview'}
        </button>
      )}

      {/* Duration badge */}
      {embed?.duration_seconds && embed.duration_seconds > 0 && (
        <span className="absolute bottom-2 left-2 z-10 rounded-[4px] bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white [font-variant-numeric:tabular-nums]">
          {formatDuration(embed.duration_seconds)}
        </span>
      )}

      {/* Provider badge */}
      {embed?.provider_name && variant !== 'compact' && (
        <span className="absolute right-2 top-2 z-10 rounded-[4px] bg-black/60 px-1.5 py-0.5 text-xs font-semibold text-white backdrop-blur-sm">
          {embed.provider_name}
        </span>
      )}
    </div>
  );
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
