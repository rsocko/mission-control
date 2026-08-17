'use client';

import type { ComponentType } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useListAnimate } from '@/lib/hooks/useListAnimate';
import {
  Archive,
  BookOpen,
  Boxes,
  Camera,
  Check,
  CheckCircle2,
  Clock3,
  Code2,
  Box,
  ExternalLink,
  FileCheck,
  FileText,
  FolderGit2,
  Globe,
  Image,
  Link2,
  ListTodo,
  Loader2,
  MessageCircle,
  Music,
  Play,
  PlayCircle,
  RotateCw,
  ShoppingCart,
  Star,
  Telescope,
  Workflow,
  Maximize2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';
import type { TriageActionRecord, TriageActionType, TriageContentType, TriageItem } from '@/types';
import { TRIAGE_SOURCE_ICONS } from '@/components/triage/types';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';

// ─── Source/content metadata ────────────────────────────────────────────────

const SOURCE_META: Record<string, { label: string; icon: ComponentType<{ className?: string; size?: number }>; badgeCls: string; iconPath?: string }> = {
  reddit: { label: 'Reddit', icon: MessageCircle, iconPath: TRIAGE_SOURCE_ICONS.reddit, badgeCls: 'bg-orange-500/10 text-orange-300 border-orange-500/20' },
  github: { label: 'GitHub', icon: FolderGit2, iconPath: TRIAGE_SOURCE_ICONS.github, badgeCls: 'bg-violet-500/10 text-violet-300 border-violet-500/20' },
  youtube: { label: 'YouTube', icon: PlayCircle, iconPath: TRIAGE_SOURCE_ICONS.youtube, badgeCls: 'bg-red-500/10 text-red-300 border-red-500/20' },
  instagram: { label: 'Instagram', icon: Camera, iconPath: TRIAGE_SOURCE_ICONS.instagram, badgeCls: 'bg-pink-500/10 text-pink-300 border-pink-500/20' },
  tiktok: { label: 'TikTok', icon: Music, iconPath: TRIAGE_SOURCE_ICONS.tiktok, badgeCls: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20' },
  pinterest: { label: 'Pinterest', icon: Image, iconPath: TRIAGE_SOURCE_ICONS.pinterest, badgeCls: 'bg-rose-500/10 text-rose-300 border-rose-500/20' },
  'document-intelligence': { label: 'OWL', icon: FileCheck, iconPath: TRIAGE_SOURCE_ICONS['document-intelligence'], badgeCls: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  scout: { label: 'Scout', icon: Telescope, badgeCls: 'bg-purple-500/10 text-purple-300 border-purple-500/20' },
  ios_share: { label: 'iOS', icon: Link2, badgeCls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
  android_share: { label: 'Android', icon: Link2, badgeCls: 'bg-green-500/10 text-green-300 border-green-500/20' },
  browser_extension: { label: 'Browser', icon: Link2, badgeCls: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
  web: { label: 'Web', icon: Globe, badgeCls: 'bg-slate-500/10 text-slate-300 border-slate-500/20' },
};

const CONTENT_TYPE_ICON: Record<TriageContentType, ComponentType<{ className?: string; size?: number }>> = {
  video: Play,
  image: Image,
  repo: Code2,
  model_3d: Box,
  article: FileText,
  link: Globe,
  text_post: MessageCircle,
  product: ShoppingCart,
  document: FileCheck,
};

const ACTION_QUICK: Array<{ type: TriageActionType; icon: ComponentType<{ className?: string; size?: number }>; label: string; primary?: boolean }> = [
  { type: 'save_karakeep', icon: Archive, label: 'Karakeep' },
  { type: 'save_knowledge_base', icon: BookOpen, label: 'Knowledge Base' },
  { type: 'save_model_catalog', icon: Boxes, label: 'Model Catalog' },
  { type: 'create_task_todo', icon: ListTodo, label: 'Todo' },
  { type: 'trigger_workflow', icon: Workflow, label: 'Workflow' },
  { type: 'dismiss', icon: X, label: 'Dismiss' },
];

const ACTION_QUICK_DOCUMENT: Array<{ type: TriageActionType; icon: ComponentType<{ className?: string; size?: number }>; label: string; primary?: boolean }> = [
  { type: 'complete_action', icon: CheckCircle2, label: 'Complete' },
  { type: 'open_document', icon: ExternalLink, label: 'Open Document' },
  { type: 'defer_action', icon: Clock3, label: 'Defer' },
  { type: 'dismiss', icon: X, label: 'Dismiss' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getScoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400';
  if (score >= 60) return 'text-amber-300';
  return 'text-slate-400';
}

function getTimeSince(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function isVideoContent(item: TriageItem): boolean {
  return item.contentType === 'video' || item.sourcePlatform === 'youtube';
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function isRepoContent(item: TriageItem): boolean {
  return item.contentType === 'repo' || item.sourcePlatform === 'github';
}

function isDocumentContent(item: TriageItem): boolean {
  return item.contentType === 'document' || item.sourcePlatform === 'document-intelligence';
}

function isTextPostContent(item: TriageItem): boolean {
  return item.contentType === 'text_post';
}

function getRepoMeta(item: TriageItem) {
  const meta = item.rawMetadata || {};
  return {
    language: (meta.language as string) || null,
    stars: typeof meta.stargazersCount === 'number' ? meta.stargazersCount : null,
    fullName: (meta.fullName as string) || item.title,
  };
}

function getTextPostMeta(item: TriageItem) {
  const meta = item.rawMetadata || {};
  return {
    author: (meta.author as string) || null,
    subreddit: (meta.subredditNamePrefixed as string) || null,
  };
}

// ─── Video Hover-to-Play Thumbnail ──────────────────────────────────────────

function getYouTubeVideoId(item: TriageItem): string | null {
  const url = item.sourceUrl || '';
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];
  const meta = item.rawMetadata || {};
  if (typeof meta.videoId === 'string') return meta.videoId;
  return null;
}

function getInstagramShortcode(item: TriageItem): string | null {
  const url = item.sourceUrl || item.canonicalUrl || '';
  const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match?.[1] || null;
}

function getInstagramEmbedPrefix(item: TriageItem): string {
  const url = item.sourceUrl || item.canonicalUrl || '';
  return /\/reels?\//.test(url) ? 'reel' : 'p';
}

function VideoHoverThumbnail({
  item,
  isVideo,
  source,
  primaryAction,
  onAction,
  busyAction,
}: {
  item: TriageItem;
  isVideo: boolean;
  source: { label: string; icon: ComponentType<{ className?: string; size?: number }>; badgeCls: string };
  primaryAction: TriageActionType;
  onAction: (actionType: TriageActionType) => void;
  busyAction: string | null;
}) {
  const [isHovering, setIsHovering] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const youtubeId = isVideo ? getYouTubeVideoId(item) : null;

  // Reset thumb failure state when item changes
  useEffect(() => {
    setThumbFailed(false);
  }, [item.id]);

  const handleMouseEnter = useCallback(() => {
    if (!youtubeId) return;
    // Delay iframe load slightly to avoid flicker on quick mouse passes
    hoverTimerRef.current = setTimeout(() => setIsHovering(true), 400);
  }, [youtubeId]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsHovering(false);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const embed = item.rawMetadata?.embed as { thumbnail_url?: string; duration_seconds?: number; type?: string; html?: string } | undefined;
  const thumb = item.thumbnailUrl || embed?.thumbnail_url;
  const dur = embed?.duration_seconds;
  const hasRichEmbed = !!(embed?.html && (embed.type === 'rich' || (embed.type === 'video' && !isVideo)));

  // Instagram embed: show inline iframe when no valid thumbnail
  const isInstagram = item.sourcePlatform === 'instagram';
  const instagramShortcode = isInstagram ? getInstagramShortcode(item) : null;
  const instagramPrefix = isInstagram ? getInstagramEmbedPrefix(item) : 'p';
  const showInstagramEmbed = isInstagram && (!thumb || thumbFailed) && instagramShortcode;

  const thumbnailAspect =
    item.sourcePlatform === 'tiktok' ? 'aspect-[9/16]' :
    item.sourcePlatform === 'instagram' || item.sourcePlatform === 'pinterest' ? 'aspect-[4/5]' :
    'aspect-video';

  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden bg-[var(--surface-2)]',
        thumbnailAspect,
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Show iframe on hover for YouTube videos */}
      {isHovering && youtubeId ? (
        <iframe
          src={`https://www.youtube.com/embed/${youtubeId}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&loop=1`}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; encrypted-media"
          loading="lazy"
          title="Video preview"
        />
      ) : showInstagramEmbed ? (
        /* Instagram inline embed — zoomed to show media content only */
        <div className="absolute inset-0 z-0 overflow-hidden">
          <iframe
            src={`https://www.instagram.com/${instagramPrefix}/${instagramShortcode}/embed/?captioned=false`}
            className="absolute left-1/2 top-0 h-[200%] w-[200%] -translate-x-1/2 origin-top scale-[0.55]"
            loading="lazy"
            title="Instagram preview"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            style={{ pointerEvents: 'none' }}
          />
        </div>
      ) : (
        <>
          {thumb && !thumbFailed ? (
            <img
              src={thumb}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <ContentTypeIcon contentType={item.contentType} />
          )}

          {/* Play overlay for video content */}
          {isVideo && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Play size={32} className="text-white opacity-85 drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)] transition-[opacity,transform] duration-100 group-hover:scale-110 group-hover:opacity-100" fill="white" />
            </div>
          )}
        </>
      )}

      {/* Platform badge - top left */}
      <span className={cn('absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.5px]', source.badgeCls)}>
        <TriageSourceIcon source={item.sourcePlatform} size={10} decorative />
        {source.label}
      </span>

      {/* Score badge - top right */}
      <span className={cn('absolute right-2 top-2 z-10 rounded-[6px] bg-black/70 px-1.5 py-0.5 text-[12px] font-bold backdrop-blur-sm [font-variant-numeric:tabular-nums]', getScoreColor(item.aiRelevanceScore))}>
        {item.aiRelevanceScore}
      </span>

      {/* Urgency badge */}
      {item.aiUrgency === 'time_sensitive' && (
        <span className="absolute bottom-2 left-2 z-10 rounded-[4px] border border-red-500/30 bg-red-500/20 px-1.5 py-0.5 text-[12px] font-semibold text-red-300 transition-opacity duration-150 group-hover:opacity-0">
          Time sensitive
        </span>
      )}

      {/* Duration badge for video content */}
      {isVideo && dur && dur > 0 && (
        <span className="absolute bottom-2 right-2 z-10 rounded-[4px] bg-black/80 px-1.5 py-0.5 text-[12px] font-semibold text-white [font-variant-numeric:tabular-nums] transition-opacity duration-150 group-hover:opacity-0">
          {formatDuration(dur)}
        </span>
      )}

      {/* 3D model rotate hint */}
      {item.contentType === 'model_3d' && !isHovering && (
        <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-[4px] bg-black/70 px-1.5 py-0.5 text-[12px] text-emerald-300 transition-opacity duration-150 group-hover:opacity-0">
          <RotateCw size={10} />
          <span>3D</span>
        </div>
      )}

      {/* Rich embed available indicator — hidden on hover when quick actions appear */}
      {hasRichEmbed && !isHovering && (
        <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-[4px] bg-black/70 px-1.5 py-0.5 text-[12px] text-blue-300 transition-opacity duration-150 group-hover:opacity-0">
          <Maximize2 size={10} />
          <span>Embed</span>
        </div>
      )}

      {/* Gallery indicator for multi-image posts */}
      {!isHovering && Array.isArray(item.rawMetadata?.galleryUrls) && (item.rawMetadata.galleryUrls as string[]).length > 1 && (
        <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-[4px] bg-black/70 px-1.5 py-0.5 text-[12px] text-white transition-opacity duration-150 group-hover:opacity-0">
          <Image size={10} />
          <span>{(item.rawMetadata.galleryUrls as string[]).length}</span>
        </div>
      )}

      {/* Hover overlay + quick actions */}
      <div className="pointer-events-none absolute inset-0 z-20 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      <QuickActions primaryAction={primaryAction} onAction={onAction} busyAction={busyAction} actionsTaken={item.actionsTaken} />
    </div>
  );
}

// ─── Gallery Card ───────────────────────────────────────────────────────────

function GalleryCard({
  item,
  isFocused,
  onSelect,
  onAction,
  busyAction,
}: {
  item: TriageItem;
  isFocused: boolean;
  onSelect: () => void;
  onAction: (actionType: TriageActionType) => void;
  busyAction: string | null;
}) {
  const source = SOURCE_META[item.sourcePlatform] || SOURCE_META.web;
  const isVideo = isVideoContent(item);
  const isRepo = isRepoContent(item);
  const isDocument = isDocumentContent(item);
  const isTextPost = isTextPostContent(item);
  const repo = isRepo ? getRepoMeta(item) : null;
  const textPost = isTextPost ? getTextPostMeta(item) : null;

  // Determine primary action based on content type
  const primaryAction = item.aiSuggestedActions[0]?.actionType || (isDocument ? 'complete_action' : 'save_karakeep');

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group relative cursor-pointer overflow-hidden rounded-[12px] border bg-[var(--surface-1)] shadow-[0_1px_3px_rgba(0,0,0,0.3),0_1px_2px_rgba(0,0,0,0.2)] transition-[border-color,box-shadow,transform] duration-150',
        isFocused
          ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent),0_8px_24px_rgba(59,130,246,0.2)]'
          : 'border-transparent hover:border-[var(--surface-3)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)] hover:-translate-y-0.5',
      )}
    >
      {/* Thumbnail area */}
      {isRepo ? (
        // Repo-style card
        <div className="relative flex min-h-[120px] flex-col items-start justify-start bg-[var(--surface-2)] p-4">
          {/* Language bar */}
          {repo?.language && (
            <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
              <div className="h-full w-[70%] rounded-full bg-cyan-500" />
            </div>
          )}
          <div className="mb-2 flex items-center gap-2">
            <FolderGit2 size={18} className="text-[var(--text-tertiary)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">{repo?.fullName || item.title}</span>
          </div>
          {item.description && (
            <p className="mb-2 line-clamp-2 text-[12px] text-[var(--text-tertiary)]">{item.description}</p>
          )}
          <div className="mt-auto flex items-center gap-3">
            {repo?.stars != null && (
              <span className="flex items-center gap-1 text-[12px] text-[var(--text-tertiary)]">
                <Star size={10} className="text-yellow-400" />
                {repo.stars >= 1000 ? `${(repo.stars / 1000).toFixed(1)}k` : repo.stars}
              </span>
            )}
            {repo?.language && (
              <span className="flex items-center gap-1 text-[12px] text-[var(--text-tertiary)]">
                <Code2 size={10} />
                {repo.language}
              </span>
            )}
          </div>

          {/* Score badge */}
          <span className={cn('absolute right-2 top-2 rounded-[6px] bg-black/70 px-1.5 py-0.5 text-[12px] font-bold backdrop-blur-sm [font-variant-numeric:tabular-nums]', getScoreColor(item.aiRelevanceScore))}>
            {item.aiRelevanceScore}
          </span>

          {/* Hover overlay + actions */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
          <QuickActions primaryAction={primaryAction} onAction={onAction} busyAction={busyAction} actionsTaken={item.actionsTaken} />
        </div>
      ) : isDocument ? (
        // Document card — matches mockup doc-intelligence-gallery-cards style
        <DocumentCardThumbnail item={item} source={source} primaryAction={primaryAction} onAction={onAction} busyAction={busyAction} />
      ) : isTextPost ? (
        // Embedded text post card — matches mockup X/Twitter style (line 752-789)
        <div className="relative flex min-h-[120px] flex-col justify-center bg-[var(--surface-0)] p-4">
          <div className="mb-2 flex items-center gap-2">
            <div className="h-6 w-6 rounded-full bg-[var(--surface-3)]" />
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">
              {textPost?.author ? `@${textPost.author}` : source.label}
            </div>
          </div>
          <p className="line-clamp-3 text-[12px] text-[var(--text-secondary)]">
            {item.description || item.aiSummary || item.title}
          </p>

          {/* Platform badge */}
          <span className={cn('absolute left-2 top-2 inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.5px]', source.badgeCls)}>
            <TriageSourceIcon source={item.sourcePlatform} size={10} decorative />
            {source.label}
          </span>

          {/* Score badge */}
          <span className={cn('absolute right-2 top-2 rounded-[6px] bg-black/70 px-1.5 py-0.5 text-[12px] font-bold backdrop-blur-sm [font-variant-numeric:tabular-nums]', getScoreColor(item.aiRelevanceScore))}>
            {item.aiRelevanceScore}
          </span>

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
          <QuickActions primaryAction={primaryAction} onAction={onAction} busyAction={busyAction} actionsTaken={item.actionsTaken} />
        </div>
      ) : (
        // Standard thumbnail (video / image / generic) with hover-to-play for videos
        <VideoHoverThumbnail item={item} isVideo={isVideo} source={source} primaryAction={primaryAction} onAction={onAction} busyAction={busyAction} />
      )}

      {/* Card body */}
      <div className="p-3">
        {!isRepo && (
          <h3 className="mb-1 line-clamp-2 text-xs font-medium text-[var(--text-primary)]">{item.title}</h3>
        )}
        {isDocument ? (
          <DocumentCardMeta item={item} />
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-[var(--text-tertiary)]">
              {item.sourcePlatform === 'reddit' && item.rawMetadata?.subredditNamePrefixed
                ? `${item.rawMetadata.subredditNamePrefixed}`
                : source.label}
              {' · '}
              {getTimeSince(item.capturedAt)}
            </span>
            {/* AI suggestion dot */}
            {item.aiSuggestedActions[0] && (
              <span
                className={cn('ml-auto inline-block h-1.5 w-1.5 rounded-full', getScoreColor(Math.round(item.aiSuggestedActions[0].confidence * 100)))}
                title={`AI: ${item.aiSuggestedActions[0].label} (${Math.round(item.aiSuggestedActions[0].confidence * 100)}%)`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Document Gallery Card ──────────────────────────────────────────────────

const ACTION_TYPE_STYLES: Record<string, string> = {
  pay: 'border-red-800/70 bg-red-900/40 text-red-300',
  respond: 'border-orange-800/70 bg-orange-900/40 text-orange-300',
  sign: 'border-yellow-800/70 bg-yellow-900/40 text-yellow-300',
  file: 'border-blue-800/70 bg-blue-900/40 text-blue-300',
  review: 'border-purple-800/70 bg-purple-900/40 text-purple-300',
  schedule: 'border-green-800/70 bg-green-900/40 text-green-300',
};

const PRIORITY_STYLES: Record<string, string> = {
  critical: 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]',
  high: 'bg-orange-500',
  medium: 'bg-amber-400',
  low: 'bg-sky-400',
};

function DocumentCardThumbnail({
  item,
  source,
  primaryAction,
  onAction,
  busyAction,
}: {
  item: TriageItem;
  source: { label: string; icon: ComponentType<{ className?: string; size?: number }>; badgeCls: string };
  primaryAction: TriageActionType;
  onAction: (actionType: TriageActionType) => void;
  busyAction: string | null;
}) {
  const meta = item.rawMetadata || {};
  const actionType = (meta.actionType as string) || '';
  const urgency = (meta.urgency as string) || '';
  const amount = meta.amount as number | undefined;
  const correspondent = meta.correspondent as string | undefined;

  return (
    <div className="relative flex min-h-[120px] flex-col justify-end overflow-hidden bg-[var(--surface-2)] p-3">
      {/* Faint document line-art background */}
      <div className="absolute inset-0 flex flex-col gap-[5px] p-3.5 opacity-25">
        <div className="h-1 w-full rounded-sm bg-[var(--text-tertiary)]" />
        <div className="h-1 w-[80%] rounded-sm bg-[var(--text-tertiary)]" />
        <div className="h-1 w-[65%] rounded-sm bg-[var(--text-tertiary)]" />
        <div className="h-1 w-full rounded-sm bg-[var(--text-tertiary)]" />
        <div className="h-1 w-[50%] rounded-sm bg-[var(--text-tertiary)]" />
        <div className="h-1 w-[40%] rounded-sm bg-[var(--accent)] opacity-60" />
      </div>

      {/* Source badge — top left */}
      <span className={cn('absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.5px]', source.badgeCls)}>
        <TriageSourceIcon source={item.sourcePlatform} size={10} decorative />
        {source.label}
      </span>

      {/* Score badge — top right */}
      <span className={cn('absolute right-2 top-2 z-10 rounded-[6px] bg-black/70 px-1.5 py-0.5 text-[12px] font-bold backdrop-blur-sm [font-variant-numeric:tabular-nums]', getScoreColor(item.aiRelevanceScore))}>
        {item.aiRelevanceScore}
      </span>

      {/* Action type chip */}
      {actionType && (
        <span className={cn('relative z-[2] mb-1 inline-flex w-fit items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', ACTION_TYPE_STYLES[actionType] || 'border-slate-700 bg-slate-800/40 text-slate-300')}>
          {actionType}
          {typeof amount === 'number' && ` · $${amount}`}
        </span>
      )}

      {/* Correspondent */}
      {correspondent && (
        <span className="relative z-[2] text-[11px] font-medium text-[var(--text-secondary)]">
          {correspondent}
        </span>
      )}

      {/* Priority indicator */}
      {urgency && urgency !== 'low' && (
        <div className={cn('absolute bottom-2.5 right-2.5 z-[2] h-2 w-2 rounded-full', PRIORITY_STYLES[urgency] || '')} />
      )}

      {/* Hover overlay + document-specific quick actions */}
      <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      <QuickActions primaryAction={primaryAction} onAction={onAction} busyAction={busyAction} actionsTaken={item.actionsTaken} actions={ACTION_QUICK_DOCUMENT} />
    </div>
  );
}

// ─── Document Card Meta (card body for document items) ──────────────────────

function formatDueDate(dueDateStr: string): { label: string; isOverdue: boolean } {
  const due = new Date(dueDateStr);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return { label: 'Overdue', isOverdue: true };
  if (diffDays === 0) return { label: 'Due today', isOverdue: true };
  if (diffDays === 1) return { label: 'Due tomorrow', isOverdue: false };
  // Format as "Due Mon DD"
  const formatted = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { label: `Due ${formatted}`, isOverdue: diffDays <= 3 };
}

function DocumentCardMeta({ item }: { item: TriageItem }) {
  const meta = item.rawMetadata || {};
  const correspondent = meta.correspondent as string | undefined;
  const amount = meta.amount as number | undefined;
  const dueDate = meta.dueDate as string | undefined;
  const documentUrl = meta.documentUrl as string | undefined;

  const due = dueDate ? formatDueDate(dueDate) : null;

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex-1 truncate text-[12px] text-[var(--text-tertiary)]">
        {due ? (
          <span className={due.isOverdue ? 'text-red-400' : ''}>
            <Clock3 size={9} className="mr-0.5 inline-block" />
            {due.label}
          </span>
        ) : correspondent ? (
          correspondent
        ) : (
          'Document'
        )}
        {correspondent && due && <span className="text-[var(--text-tertiary)]">{' · '}{correspondent}</span>}
      </span>
      {typeof amount === 'number' ? (
        <span className={cn('shrink-0 text-[12px] font-semibold [font-variant-numeric:tabular-nums]', due?.isOverdue ? 'text-red-400' : 'text-emerald-400')}>
          ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      ) : due ? (
        <span className={cn('shrink-0 text-[12px] font-medium', due.isOverdue ? 'text-red-400' : 'text-[var(--text-tertiary)]')}>
          {due.isOverdue ? 'Overdue' : ''}
        </span>
      ) : documentUrl ? (
        <a
          href={documentUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-[11px] text-[var(--accent)] hover:underline"
        >
          View in Paperless-ngx
        </a>
      ) : null}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ContentTypeIcon({ contentType }: { contentType: TriageContentType }) {
  const Icon = CONTENT_TYPE_ICON[contentType] || Globe;
  const color: Record<string, string> = {
    video: 'text-red-500/25',
    model_3d: 'text-emerald-500/25',
    repo: 'text-violet-500/25',
    article: 'text-blue-500/25',
    product: 'text-amber-500/25',
    image: 'text-pink-500/25',
    link: 'text-slate-500/25',
    text_post: 'text-orange-500/25',
    document: 'text-blue-500/25',
  };
  return <Icon size={48} className={color[contentType] || 'text-slate-500/25'} />;
}

function QuickActions({
  primaryAction,
  onAction,
  busyAction,
  actionsTaken,
  actions,
}: {
  primaryAction: TriageActionType;
  onAction: (actionType: TriageActionType) => void;
  busyAction: string | null;
  actionsTaken?: TriageActionRecord[];
  actions?: typeof ACTION_QUICK;
}) {
  const actionList = actions || ACTION_QUICK;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-1 p-2 opacity-0 transition-[opacity,transform] duration-150 translate-y-1 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100">
      {actionList.map((action) => {
        const Icon = action.icon;
        const isPrimary = action.type === primaryAction;
        const isBusy = busyAction === action.type;
        const alreadyDone = actionsTaken?.some((a) => a.actionType === action.type) ?? false;
        return (
          <button
            key={action.type}
            type="button"
            title={alreadyDone ? `${action.label} (done)` : action.label}
            onClick={(e) => {
              e.stopPropagation();
              if (!alreadyDone) onAction(action.type);
            }}
            disabled={!!busyAction || alreadyDone}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-[8px] border backdrop-blur-sm transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.96] disabled:opacity-40',
              alreadyDone
                ? 'border-green-500/40 bg-green-900/40 text-green-400'
                : isPrimary
                  ? 'border-[var(--accent)] bg-[var(--accent-600)] text-white'
                  : 'border-white/15 bg-[var(--surface-1)]/90 text-[var(--text-tertiary)] hover:border-[var(--accent)] hover:bg-[var(--accent-600)] hover:text-white',
            )}
          >
            {isBusy ? <Loader2 size={13} className="animate-spin" /> : alreadyDone ? <Check size={13} /> : <Icon size={13} />}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main Gallery Component ─────────────────────────────────────────────────

export type GalleryDensity = 'spacious' | 'default' | 'compact';

const DENSITY_COLUMNS: Record<GalleryDensity, number> = {
  spacious: 3,
  default: 4,
  compact: 5,
};

interface TriageGalleryViewProps {
  items: TriageItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAction: (id: string, actionType: TriageActionType) => void;
  busyAction: string | null;
  loading: boolean;
  density?: GalleryDensity;
  onDensityChange?: (density: GalleryDensity) => void;
}

export default function TriageGalleryView({
  items,
  selectedId,
  onSelect,
  onAction,
  busyAction,
  loading,
  density = 'default',
  onDensityChange,
}: TriageGalleryViewProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const [animateRef] = useListAnimate({ duration: 250 });

  // Merge gridRef (for keyboard nav) and animateRef (for auto-animate)
  const mergedGridRef = useCallback((node: HTMLDivElement | null) => {
    (gridRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    if (typeof animateRef === 'function') {
      animateRef(node);
    }
  }, [animateRef]);

  // Keep focusIndex in bounds when items change
  useEffect(() => {
    if (focusIndex >= items.length && items.length > 0) {
      setFocusIndex(items.length - 1);
    }
  }, [items.length, focusIndex]);

  // Sync focusIndex when selectedId changes from external source
  useEffect(() => {
    if (selectedId) {
      const idx = items.findIndex((i) => i.id === selectedId);
      if (idx >= 0 && idx !== focusIndex) setFocusIndex(idx);
    }
  }, [selectedId, items, focusIndex]);

  // Calculate columns from density setting for arrow nav
  const getColumns = useCallback(() => {
    return DENSITY_COLUMNS[density];
  }, [density]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (shouldBlockGlobalShortcut(e)) return;
      // Ignore if focus is in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Density shortcuts: 1/2/3
      if (onDensityChange && !e.metaKey && !e.ctrlKey) {
        if (e.key === '1') { onDensityChange('spacious'); return; }
        if (e.key === '2') { onDensityChange('default'); return; }
        if (e.key === '3') { onDensityChange('compact'); return; }
      }

      const cols = getColumns();
      let nextIndex = focusIndex;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          nextIndex = Math.min(focusIndex + 1, items.length - 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          nextIndex = Math.max(focusIndex - 1, 0);
          break;
        case 'ArrowDown':
          e.preventDefault();
          nextIndex = Math.min(focusIndex + cols, items.length - 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          nextIndex = Math.max(focusIndex - cols, 0);
          break;
        case 'Enter': {
          e.preventDefault();
          const item = items[focusIndex];
          if (item) onSelect(item.id);
          return;
        }
        // Quick action shortcuts on focused card
        case 'k':
        case 'K': {
          const item = items[focusIndex];
          if (item) onAction(item.id, 'save_karakeep');
          return;
        }
        case 'm':
        case 'M': {
          const item = items[focusIndex];
          if (item) onAction(item.id, 'save_model_catalog');
          return;
        }
        case 'n':
        case 'N': {
          const item = items[focusIndex];
          if (item) onAction(item.id, 'save_knowledge_base');
          return;
        }
        case 't':
        case 'T': {
          const item = items[focusIndex];
          if (item) onAction(item.id, 'create_task_todo');
          return;
        }
        case 'd':
        case 'D': {
          const item = items[focusIndex];
          if (item) onAction(item.id, 'dismiss');
          return;
        }
        default:
          return;
      }

      if (nextIndex !== focusIndex) {
        setFocusIndex(nextIndex);
        onSelect(items[nextIndex].id);

        // Scroll focused card into view
        const cards = gridRef.current?.children;
        if (cards?.[nextIndex]) {
          (cards[nextIndex] as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusIndex, items, getColumns, onSelect, onAction, onDensityChange]);

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center text-[var(--text-tertiary)]">
        <Loader2 className="animate-spin" size={18} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-2 text-center">
        <Globe size={24} className="text-[var(--text-tertiary)]" />
        <div className="text-sm font-medium text-[var(--text-primary)]">No triage items match these filters.</div>
        <div className="text-xs text-[var(--text-tertiary)]">Clear filters or capture a new URL above.</div>
      </div>
    );
  }

  return (
    <div>
      {/* Responsive override: collapse columns on smaller screens */}
      <style>{`
        .gallery-masonry-grid {
          --gallery-cols: ${DENSITY_COLUMNS[density]};
          grid-template-columns: repeat(var(--gallery-cols), 1fr);
        }
        @media (max-width: 1024px) {
          .gallery-masonry-grid { --gallery-cols: ${Math.min(DENSITY_COLUMNS[density], 3)}; }
        }
        @media (max-width: 768px) {
          .gallery-masonry-grid { --gallery-cols: 2; }
        }
        @media (max-width: 480px) {
          .gallery-masonry-grid { --gallery-cols: 1; }
        }
      `}</style>
      <div
        ref={mergedGridRef}
        className="gallery-masonry-grid grid items-start gap-4"
      >
        {items.map((item, index) => (
          <GalleryCard
            key={item.id}
            item={item}
            isFocused={index === focusIndex}
            onSelect={() => {
              setFocusIndex(index);
              onSelect(item.id);
            }}
            onAction={(actionType) => onAction(item.id, actionType)}
            busyAction={busyAction}
          />
        ))}
      </div>

      {/* Keyboard hints */}
      <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[8px] border border-[var(--surface-3)] bg-[var(--surface-1)] px-4 py-2 text-[12px] text-[var(--text-tertiary)] shadow-[0_4px_12px_rgba(0,0,0,0.5)]">
        <span className="flex items-center gap-1.5">
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">←</kbd>
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">→</kbd>
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">↑</kbd>
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">↓</kbd>
          Navigate
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">1</kbd>
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">2</kbd>
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">3</kbd>
          Density
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">K</kbd>
          Karakeep
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">D</kbd>
          Dismiss
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="rounded-[3px] border border-[var(--surface-3)] bg-[var(--surface-0)] px-1 py-0.5 font-mono text-[12px] font-semibold text-[var(--text-tertiary)]">G</kbd>
          Toggle view
        </span>
      </div>
    </div>
  );
}
