import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  Boxes,
  Camera,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileCheck,
  FolderGit2,
  BookOpen,
  Globe,
  Image,
  Layers,
  Link2,
  ListTodo,
  MessageCircle,
  MoreHorizontal,
  Music,
  PlayCircle,
  Puzzle,
  RotateCcw,
  Share2,
  Telescope,
  Users,
  Workflow,
} from 'lucide-react';
import type { TriageActionType, TriageSourcePlatform, TriageStatus } from '@/types';

/** Paths to full-color brand SVGs for triage sources */
export const TRIAGE_SOURCE_ICONS: Record<string, string> = {
  reddit: '/icons/triage-sources/reddit.svg',
  github: '/icons/triage-sources/github.svg',
  youtube: '/icons/triage-sources/youtube.svg',
  instagram: '/icons/triage-sources/instagram.svg',
  facebook: '/icons/triage-sources/facebook.svg',
  twitter: '/icons/triage-sources/twitter.svg',
  tiktok: '/icons/triage-sources/tiktok.svg',
  pinterest: '/icons/triage-sources/pinterest.svg',
  'document-intelligence': '/icons/agents/owl.svg',
};

export type ViewMode = 'stream' | 'gallery' | 'focus';
export type SyncImportSource = 'github-stars' | 'reddit-saved';
export type TriageSortOption = 'relevance' | 'newest' | 'oldest' | 'score';

export const SORT_OPTIONS: Array<{ value: TriageSortOption; label: string }> = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'score', label: 'AI Score' },
];

export const CONTENT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'link', label: 'Links' },
  { value: 'repo', label: 'Repos' },
  { value: 'model_3d', label: '3D Models' },
  { value: 'video', label: 'Videos' },
  { value: 'article', label: 'Articles' },
  { value: 'image', label: 'Images' },
  { value: 'text_post', label: 'Discussions' },
  { value: 'product', label: 'Products' },
  { value: 'document', label: 'Documents' },
];

export type Stats = {
  total: number;
  pending: number;
  snoozed: number;
  actioned: number;
  dismissed: number;
  sourceCounts: Record<string, number>;
};

export type SyncSourceState = {
  configured: boolean;
  syncState: {
    lastSyncedAt: string | null;
    totalImported: number;
    totalSkipped: number;
    lastRunImported: number;
    lastRunSkipped: number;
    lastRunDurationMs: number | null;
    lastRunErrors: string[];
  } | null;
};

export type SyncStatus = {
  sources: Record<string, SyncSourceState>;
};

export const SOURCE_OPTIONS: Array<{ value: TriageSourcePlatform | 'all'; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'reddit', label: 'Reddit' },
  { value: 'github', label: 'GitHub' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'twitter', label: 'X / Twitter' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'pinterest', label: 'Pinterest' },
  { value: 'document-intelligence', label: 'OWL' },
  { value: 'scout', label: 'Scout' },
  { value: 'ios_share', label: 'iOS Share' },
  { value: 'android_share', label: 'Android Share' },
  { value: 'browser_extension', label: 'Browser Extension' },
  { value: 'browser_tabs', label: 'Browser Tabs' },
  { value: 'web', label: 'Web Capture' },
];

export const STATUS_OPTIONS: Array<{ value: TriageStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All items' },
  { value: 'pending', label: 'Pending' },
  { value: 'snoozed', label: 'Snoozed' },
  { value: 'actioned', label: 'Actioned' },
  { value: 'dismissed', label: 'Dismissed' },
];

export const SOURCE_META: Record<
  string,
  { label: string; icon: LucideIcon; badge: string; iconPath?: string }
> = {
  reddit: { label: 'Reddit', icon: MessageCircle, iconPath: TRIAGE_SOURCE_ICONS.reddit, badge: 'bg-orange-500/10 text-orange-300 border-orange-500/20' },
  github: { label: 'GitHub', icon: FolderGit2, iconPath: TRIAGE_SOURCE_ICONS.github, badge: 'bg-violet-500/10 text-violet-300 border-violet-500/20' },
  youtube: { label: 'YouTube', icon: PlayCircle, iconPath: TRIAGE_SOURCE_ICONS.youtube, badge: 'bg-red-500/10 text-red-300 border-red-500/20' },
  instagram: { label: 'Instagram', icon: Camera, iconPath: TRIAGE_SOURCE_ICONS.instagram, badge: 'bg-pink-500/10 text-pink-300 border-pink-500/20' },
  facebook: { label: 'Facebook', icon: Users, iconPath: TRIAGE_SOURCE_ICONS.facebook, badge: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  twitter: { label: 'X / Twitter', icon: MessageCircle, iconPath: TRIAGE_SOURCE_ICONS.twitter, badge: 'bg-sky-500/10 text-sky-300 border-sky-500/20' },
  tiktok: { label: 'TikTok', icon: Music, iconPath: TRIAGE_SOURCE_ICONS.tiktok, badge: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20' },
  pinterest: { label: 'Pinterest', icon: Image, iconPath: TRIAGE_SOURCE_ICONS.pinterest, badge: 'bg-rose-500/10 text-rose-300 border-rose-500/20' },
  'document-intelligence': { label: 'OWL', icon: FileCheck, iconPath: TRIAGE_SOURCE_ICONS['document-intelligence'], badge: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  scout: { label: 'Scout', icon: Telescope, badge: 'bg-purple-500/10 text-purple-300 border-purple-500/20' },
  ios_share: { label: 'iOS Share', icon: Share2, badge: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
  android_share: { label: 'Android Share', icon: Share2, badge: 'bg-green-500/10 text-green-300 border-green-500/20' },
  browser_extension: { label: 'Browser', icon: Puzzle, badge: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
  browser_tabs: { label: 'Browser Tabs', icon: Layers, badge: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20' },
  web: { label: 'Web', icon: Globe, badge: 'bg-slate-500/10 text-slate-300 border-slate-500/20' },
};

export const ACTION_TYPE_OPTIONS: Array<{ value: TriageActionType; label: string }> = [
  { value: 'save_karakeep', label: 'Karakeep' },
  { value: 'save_knowledge_base', label: 'Knowledge Base' },
  { value: 'create_task_github', label: 'GitHub Task' },
  { value: 'create_task_todo', label: 'Todo' },
  { value: 'save_model_catalog', label: 'Model Catalog' },
  { value: 'trigger_workflow', label: 'Workflow' },
  { value: 'complete_action', label: 'Complete' },
  { value: 'open_document', label: 'Open Document' },
  { value: 'defer_action', label: 'Defer' },
  { value: 'dismiss', label: 'Dismiss' },
  { value: 'snooze', label: 'Snooze' },
  { value: 'resurface', label: 'Resurfaced' },
];

export const ACTION_META: Record<
  TriageActionType,
  { label: string; icon: ComponentType<{ className?: string; size?: number }> }
> = {
  save_karakeep: { label: 'Karakeep', icon: Archive },
  save_knowledge_base: { label: 'Knowledge Base', icon: BookOpen },
  create_task_github: { label: 'GitHub Task', icon: FolderGit2 },
  create_task_todo: { label: 'Todo', icon: ListTodo },
  save_model_catalog: { label: 'Model Catalog', icon: Boxes },
  trigger_workflow: { label: 'Workflow', icon: Workflow },
  complete_action: { label: 'Complete', icon: CheckCircle2 },
  open_document: { label: 'Open Document', icon: ExternalLink },
  defer_action: { label: 'Defer', icon: Clock3 },
  dismiss: { label: 'Dismiss', icon: MoreHorizontal },
  snooze: { label: 'Snooze', icon: Clock3 },
  resurface: { label: 'Resurfaced', icon: RotateCcw },
};

export const EMPTY_STATS: Stats = {
  total: 0,
  pending: 0,
  snoozed: 0,
  actioned: 0,
  dismissed: 0,
  sourceCounts: {},
};
