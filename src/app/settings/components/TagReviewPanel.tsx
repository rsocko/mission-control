'use client';

import React, { useEffect, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import {
  Loader2, Search, Lock, Merge, Trash2, Palette, Pencil, Globe,
  ExternalLink, CheckCircle2, XCircle, Zap, ChevronDown, ChevronRight,
  Tag as TagIcon, Eye, Download, Link2, CircleHelp, ChevronsUpDown, ChevronsDownUp,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  staggerContainer, fadeSlideUp, modalOverlay, modalContent,
} from '@/lib/motion';
import { getTagPillStyle } from '@/lib/constants/colors';
import { Tooltip } from '@/components/ui/Tooltip';
import { CONNECTOR_TYPES } from './types';
import { ConnectorBrandIcon } from './ConnectorBrandIcon';
import { SidebarNavItem } from '@/components/sidebar/SidebarNavItem';

// ─── Types ───────────────────────────────────────────────────────────────

interface ReviewTag {
  id: string;
  name: string;
  slug: string;
  type: string;
  source: string | null;
  sources: string[];
  sourceNames: string[];
  color: string | null;
  confirmed: boolean;
  usageCount: number;
  unifiedInto: string | null;
  listUsage: Array<{
    connectorInstanceId: string;
    sourceListId: string;
    usageCount: number;
  }>;
  sourceUsage: Array<{
    connectorType: string;
    usageCount: number;
  }>;
}

interface SourceListInfo {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type: string;
}

interface ConnectorInfo {
  id: string;
  type: string;
  name: string;
  capabilities: { tagCreationMode?: string; tagScope?: string; tagWriteBack?: boolean };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const subscribePortalRoot = () => () => {};
const getPortalRoot = () => document.body;
const getServerPortalRoot = () => null;

const SYSTEM_TAG_PATTERNS = [
  /^mc:/i,
  /^priority[\s:\/\-_]/i,
  /^priority$/i,
  /^p[0-3]$/i,
  /^effort[\s:\/\-_]/i,
  /^size[\s:\/\-_]/i,
];

function isSystemTag(tagName: string): boolean {
  return SYSTEM_TAG_PATTERNS.some(p => p.test(tagName));
}

function getSystemCategory(tagName: string): string | null {
  if (/^mc:/i.test(tagName)) return 'Micro-status';
  if (/^priority/i.test(tagName) || /^p[0-3]$/i.test(tagName)) return 'Priority';
  if (/^effort/i.test(tagName) || /^size/i.test(tagName)) return 'Effort';
  return null;
}

/** Simple slug-based similarity (detects "wontfix" vs "won-t-fix") */
function findMergeSuggestions(tagList: ReviewTag[]): Array<{ a: ReviewTag; b: ReviewTag }> {
  const suggestions: Array<{ a: ReviewTag; b: ReviewTag }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < tagList.length; i++) {
    for (let j = i + 1; j < tagList.length; j++) {
      const a = tagList[i], b = tagList[j];
      const key = [a.id, b.id].sort().join('|');
      if (seen.has(key)) continue;
      if (a.unifiedInto || b.unifiedInto) continue;

      // Same slug = definite duplicate
      if (a.slug === b.slug) {
        seen.add(key);
        suggestions.push({ a, b });
        continue;
      }

      // Normalized comparison: strip non-alphanum
      const normA = a.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normB = b.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normA === normB && normA.length > 2) {
        seen.add(key);
        suggestions.push({ a, b });
      }
    }
  }
  return suggestions;
}

function chooseDefaultMergeTarget(tagList: ReviewTag[]): ReviewTag {
  return [...tagList].sort((a, b) => {
    if (a.type === 'hub' && b.type !== 'hub') return -1;
    if (b.type === 'hub' && a.type !== 'hub') return 1;
    return b.usageCount - a.usageCount;
  })[0];
}

function getScopedUsageCount(
  tag: ReviewTag,
  scopeFilter: string,
  connectorSourceLists: SourceListInfo[],
): number {
  if (scopeFilter === 'all' || scopeFilter === 'local') return tag.usageCount;

  if (scopeFilter.startsWith('list:')) {
    const sourceList = connectorSourceLists.find(item => item.id === scopeFilter.slice(5));
    if (!sourceList) return 0;
    return tag.listUsage?.find(usage =>
      usage.connectorInstanceId === sourceList.connectorInstanceId
      && usage.sourceListId === sourceList.sourceId
    )?.usageCount ?? 0;
  }

  return tag.sourceUsage?.find(usage => usage.connectorType === scopeFilter)?.usageCount ?? 0;
}

// ─── Component ───────────────────────────────────────────────────────────

function TagReviewPanel() {
  const [allTags, setAllTags] = useState<ReviewTag[]>([]);
  const [sourceTagSlugs, setSourceTagSlugs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'usage-desc' | 'usage-asc' | 'name-asc' | 'name-desc'>('usage-desc');
  const [scopeFilter, setScopeFilter] = useState<string>('all');
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(true);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [expandedScopeSources, setExpandedScopeSources] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Dialogs
  const [deleteDialogTag, setDeleteDialogTag] = useState<ReviewTag | null>(null);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string>('');
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeReviewTagIds, setMergeReviewTagIds] = useState<string[]>([]);
  const [mergeReviewOrigin, setMergeReviewOrigin] = useState<'selection' | 'suggestion' | null>(null);
  const [mergeStep, setMergeStep] = useState<1 | 2>(1);
  const portalRoot = useSyncExternalStore(subscribePortalRoot, getPortalRoot, getServerPortalRoot);
  const [renameTag, setRenameTag] = useState<ReviewTag | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);
  const [recolorTag, setRecolorTag] = useState<ReviewTag | null>(null);
  const [recolorValue, setRecolorValue] = useState('');
  const [recolorLoading, setRecolorLoading] = useState(false);

  // Push-to-source
  const [pushDialogTag, setPushDialogTag] = useState<ReviewTag | null>(null);
  const [pushTargetListId, setPushTargetListId] = useState('');
  const [pushLoading, setPushLoading] = useState(false);
  const [connectorSourceLists, setConnectorSourceLists] = useState<SourceListInfo[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);

  const connectorTypeLabels = useMemo(
    () => new Map(CONNECTOR_TYPES.map((item) => [item.type, item.name])),
    [],
  );

  const connectorTypeLabel = useCallback((source: string) => {
    return connectorTypeLabels.get(source) || source.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }, [connectorTypeLabels]);

  // ─── Data Loading ────────────────────────────────────────────────────

  const refreshTags = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/tags?includeListUsage=true');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setAllTags(Array.isArray(data.tags) ? data.tags : []);
      setSourceTagSlugs(new Set(Array.isArray(data.sourceTagSlugs) ? data.sourceTagSlugs : []));
    } catch {
      toast.error('Failed to load tags');
      setAllTags([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshTags(); }, [refreshTags]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/connectors');
        if (!res.ok) return;
        const data = await res.json();
        setConnectorSourceLists(Array.isArray(data.sourceLists) ? data.sourceLists : []);
        setConnectors(Array.isArray(data.connectors) ? data.connectors : []);
      } catch { /* non-critical */ }
    })();
  }, []);

  const pushableSourceLists = useMemo(() =>
    connectorSourceLists.filter(sl => {
      const conn = connectors.find(c => c.id === sl.connectorInstanceId);
      return conn?.capabilities?.tagWriteBack;
    }),
  [connectorSourceLists, connectors]);

  // ─── Computed Data ───────────────────────────────────────────────────

  const { userTags, systemTags, aiTags, confirmedAiTags } = useMemo(() => {
    const user: ReviewTag[] = [];
    const system: ReviewTag[] = [];
    const ai: ReviewTag[] = [];
    const confirmedAi: ReviewTag[] = [];

    for (const tag of allTags) {
      if (isSystemTag(tag.name)) {
        system.push(tag);
      } else if (tag.type === 'ai-inferred' && !tag.confirmed) {
        ai.push(tag);
      } else if (tag.type === 'ai-inferred' && tag.confirmed) {
        confirmedAi.push(tag);
      } else {
        user.push(tag);
      }
    }
    return { userTags: user, systemTags: system, aiTags: ai, confirmedAiTags: confirmedAi };
  }, [allTags]);

  // Scope: connector types + individual source lists
  const scopeOptions = useMemo(() => {
    const sources = new Set<string>();
    for (const tag of allTags) {
      const tagSources = tag.sources?.length ? tag.sources : (tag.source ? [tag.source] : []);
      for (const s of tagSources) {
        sources.add(s);
      }
    }
    // Only sources whose tags are list-scoped should expose list filters.
    const listsByType = new Map<string, SourceListInfo[]>();
    for (const sl of connectorSourceLists) {
      const connector = connectors.find(item => item.id === sl.connectorInstanceId);
      if (!connector || connector.capabilities.tagScope !== 'per-list') continue;
      if (!listsByType.has(connector.type)) listsByType.set(connector.type, []);
      listsByType.get(connector.type)!.push(sl);
    }
    return { sources: Array.from(sources).sort(), listsByType };
  }, [allTags, connectorSourceLists, connectors]);

  const filteredUserTags = useMemo(() => {
    let list = userTags;

    // Scope filter
    if (scopeFilter !== 'all') {
      if (scopeFilter === 'local') {
        list = list.filter(t => t.type === 'hub' || (!t.sources?.length && !t.source));
      } else if (scopeFilter.startsWith('list:')) {
        const listId = scopeFilter.slice(5);
        const sl = connectorSourceLists.find(s => s.id === listId);
        if (sl) {
          list = list.filter(t => t.listUsage?.some(usage =>
            usage.connectorInstanceId === sl.connectorInstanceId
            && usage.sourceListId === sl.sourceId
          ));
        }
      } else {
        list = list.filter(t => {
          const tagSources = t.sources?.length ? t.sources : (t.source ? [t.source] : []);
          return tagSources.includes(scopeFilter);
        });
      }
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(t => t.name.toLowerCase().includes(q) || t.slug.includes(q));
    }

    // Sort
    list = [...list].sort((a, b) => {
      if (sortBy === 'usage-desc') {
        return getScopedUsageCount(b, scopeFilter, connectorSourceLists)
          - getScopedUsageCount(a, scopeFilter, connectorSourceLists);
      }
      if (sortBy === 'usage-asc') {
        return getScopedUsageCount(a, scopeFilter, connectorSourceLists)
          - getScopedUsageCount(b, scopeFilter, connectorSourceLists);
      }
      if (sortBy === 'name-desc') return b.name.localeCompare(a.name);
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [userTags, scopeFilter, searchQuery, sortBy, connectorSourceLists]);

  const mergeSuggestions = useMemo(() => findMergeSuggestions(userTags), [userTags]);

  const selectedTags = useMemo(() =>
    userTags.filter(t => selectedTagIds.has(t.id)),
  [userTags, selectedTagIds]);

  const mergeReviewTags = useMemo(() =>
    userTags.filter(tag => mergeReviewTagIds.includes(tag.id)),
  [userTags, mergeReviewTagIds]);

  const mergeTargetTag = useMemo(() =>
    mergeReviewTags.find(tag => tag.id === mergeTargetId) ?? null,
  [mergeReviewTags, mergeTargetId]);

  const recommendedMergeTargetId = useMemo(() =>
    mergeReviewTags.length > 0 ? chooseDefaultMergeTarget(mergeReviewTags).id : null,
  [mergeReviewTags]);

  const mergeHasSourceTags = useMemo(() =>
    mergeReviewTags.some(tag => tag.type === 'source'),
  [mergeReviewTags]);
  const mergeMode = mergeHasSourceTags ? 'unify' : 'merge';
  const cannotUseAsMergeTarget = useCallback((tag: ReviewTag) =>
    tag.type === 'source'
    && tag.usageCount === 0
    && mergeReviewTags.some(item => item.type !== 'source')
    && !mergeReviewTags.some(item =>
      item.id !== tag.id && item.type === 'source' && item.usageCount > 0
    ),
  [mergeReviewTags]);

  // ─── Actions ─────────────────────────────────────────────────────────

  const toggleSelect = useCallback((tagId: string) => {
    setSelectedTagIds(prev => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedTagIds.size === filteredUserTags.length) {
      setSelectedTagIds(new Set());
    } else {
      setSelectedTagIds(new Set(filteredUserTags.map(t => t.id)));
    }
  }, [filteredUserTags, selectedTagIds]);

  const handleConfirmAiTag = useCallback(async (tagId: string) => {
    setActionLoading(tagId);
    try {
      const response = await fetch('/api/tags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tagId, confirmed: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAllTags(prev => prev.map(tag => tag.id === tagId ? { ...tag, confirmed: true, type: 'hub' } : tag));
      toast.success('Tag confirmed');
    } catch {
      toast.error('Failed to confirm tag');
    } finally {
      setActionLoading(null);
    }
  }, []);

  const handleDeleteTag = useCallback(async (tag: ReviewTag) => {
    setActionLoading(tag.id);
    try {
      const response = await fetch(`/api/tags?id=${encodeURIComponent(tag.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAllTags(prev => prev.filter(t => t.id !== tag.id));
      setSelectedTagIds(prev => { const next = new Set(prev); next.delete(tag.id); return next; });
      toast.success(`"${tag.name}" removed`);
    } catch {
      toast.error('Failed to remove tag');
    } finally {
      setActionLoading(null);
      setDeleteDialogTag(null);
    }
  }, []);

  const handleMerge = useCallback(async () => {
    if (!mergeTargetId || mergeReviewTags.length < 2) return;
    setMergeLoading(true);
    try {
      const sourceTagIds = mergeReviewTags.map(t => t.id);
      const endpoint = mergeMode === 'unify' ? '/api/tags/unify' : '/api/tags/merge';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceTagIds, targetTagId: mergeTargetId }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${response.status}`);
      }
      const result = await response.json();
      if (mergeMode === 'unify') {
        const effects = [
          `${result.linked} tasks linked`,
          result.detached > 0 ? `${result.detached} duplicate Hub assignment${result.detached === 1 ? '' : 's'} detached` : null,
          result.removed > 0 ? `${result.removed} local tag${result.removed === 1 ? '' : 's'} removed` : null,
        ].filter(Boolean);
        toast.success(`Merged ${result.unified} tag${result.unified === 1 ? '' : 's'} in Mission Control (${effects.join(', ')})`);
      } else {
        toast.success(`Merged ${result.merged} tag${result.merged === 1 ? '' : 's'} (${result.reassigned} tasks reassigned)`);
      }
      setMergeDialogOpen(false);
      setMergeReviewTagIds([]);
      setMergeStep(1);
      if (mergeReviewOrigin === 'selection') setSelectedTagIds(new Set());
      setMergeReviewOrigin(null);
      setMergeTargetId('');
      void refreshTags();
    } catch (err) {
      toast.error(`Merge failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setMergeLoading(false);
    }
  }, [mergeTargetId, mergeReviewTags, mergeMode, mergeReviewOrigin, refreshTags]);

  const handleRename = useCallback(async () => {
    if (!renameTag || !renameValue.trim()) return;
    setRenameLoading(true);
    try {
      const response = await fetch('/api/tags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: renameTag.id, name: renameValue.trim() }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAllTags(prev => prev.map(t => t.id === renameTag.id ? { ...t, name: renameValue.trim(), slug: renameValue.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') } : t));
      toast.success(`Renamed to "${renameValue.trim()}"`);
      setRenameTag(null);
      setRenameValue('');
    } catch {
      toast.error('Failed to rename tag');
    } finally {
      setRenameLoading(false);
    }
  }, [renameTag, renameValue]);

  const handleRecolor = useCallback(async () => {
    if (!recolorTag || !recolorValue) return;
    setRecolorLoading(true);
    try {
      const response = await fetch('/api/tags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: recolorTag.id, color: recolorValue }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAllTags(prev => prev.map(t => t.id === recolorTag.id ? { ...t, color: recolorValue } : t));
      toast.success('Color updated');
      setRecolorTag(null);
      setRecolorValue('');
    } catch {
      toast.error('Failed to update color');
    } finally {
      setRecolorLoading(false);
    }
  }, [recolorTag, recolorValue]);

  const handlePushTag = useCallback(async () => {
    if (!pushDialogTag || !pushTargetListId) return;
    setPushLoading(true);
    try {
      const response = await fetch('/api/tags/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: pushDialogTag.id, sourceListId: pushTargetListId }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${response.status}`);
      }
      toast.success(`"${pushDialogTag.name}" pushed to source`);
      setPushDialogTag(null);
      setPushTargetListId('');
      void refreshTags();
    } catch (err) {
      toast.error(`Failed to push tag: ${err instanceof Error ? err.message : err}`);
    } finally {
      setPushLoading(false);
    }
  }, [pushDialogTag, pushTargetListId, refreshTags]);

  const openMergeDialog = useCallback(() => {
    if (selectedTags.length < 2) {
      toast.error('Select at least 2 tags to merge');
      return;
    }
    setMergeReviewTagIds(selectedTags.map(tag => tag.id));
    setMergeReviewOrigin('selection');
    setMergeTargetId(chooseDefaultMergeTarget(selectedTags).id);
    setMergeStep(1);
    setMergeDialogOpen(true);
  }, [selectedTags]);

  const openMergeSuggestion = useCallback((a: ReviewTag, b: ReviewTag) => {
    const reviewTags = [a, b];
    setMergeReviewTagIds(reviewTags.map(tag => tag.id));
    setMergeReviewOrigin('suggestion');
    setMergeTargetId(chooseDefaultMergeTarget(reviewTags).id);
    setMergeStep(1);
    setMergeDialogOpen(true);
  }, []);

  const closeMergeDialog = useCallback(() => {
    setMergeDialogOpen(false);
    setMergeReviewTagIds([]);
    setMergeReviewOrigin(null);
    setMergeTargetId('');
    setMergeStep(1);
  }, []);

  const router = useRouter();

  // ─── View Tasks (navigate to dashboard filtered by tag) ─────────────
  const handleViewTasks = useCallback((tag: ReviewTag) => {
    const params = new URLSearchParams({ tag: tag.slug });

    if (scopeFilter.startsWith('list:')) {
      const sourceList = connectorSourceLists.find(item => item.id === scopeFilter.slice(5));
      const connector = sourceList
        ? connectors.find(item => item.id === sourceList.connectorInstanceId)
        : undefined;
      if (sourceList) params.set('listId', `${sourceList.connectorInstanceId}:${sourceList.sourceId}`);
      if (connector) params.set('source', connector.type);
    } else if (scopeFilter !== 'all' && scopeFilter !== 'local') {
      params.set('source', scopeFilter);
    }

    router.push(`/?${params.toString()}`);
  }, [connectorSourceLists, connectors, router, scopeFilter]);

  // ─── Bulk Delete ────────────────────────────────────────────────────
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [bulkDeleteWriteBack, setBulkDeleteWriteBack] = useState(false);
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);

  const handleBulkDelete = useCallback(async () => {
    const tagsToDelete = selectedTags.filter(t => !isSystemTag(t.name));
    if (tagsToDelete.length === 0) return;
    setBulkDeleteLoading(true);
    let successCount = 0;
    try {
      // Source write-back if requested
      if (bulkDeleteWriteBack) {
        for (const tag of tagsToDelete) {
          try {
            await fetch('/api/tags/remove-from-source', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tagId: tag.id }),
            });
          } catch { /* best-effort */ }
        }
      }
      // Delete from MC
      const deletedIds: string[] = [];
      for (const tag of tagsToDelete) {
        const response = await fetch(`/api/tags?id=${encodeURIComponent(tag.id)}`, { method: 'DELETE' });
        if (response.ok) {
          successCount++;
          deletedIds.push(tag.id);
        }
      }
      if (deletedIds.length > 0) {
        setAllTags(prev => prev.filter(t => !deletedIds.includes(t.id)));
        setSelectedTagIds(prev => {
          const next = new Set(prev);
          for (const id of deletedIds) next.delete(id);
          return next;
        });
      }
      if (successCount < tagsToDelete.length) {
        toast.warning(`Removed ${successCount} of ${tagsToDelete.length} tags (some failed)`);
      } else {
        toast.success(`Removed ${successCount} tag${successCount === 1 ? '' : 's'}`);
      }
    } catch {
      toast.error('Failed to remove some tags');
    } finally {
      setBulkDeleteLoading(false);
      setBulkDeleteDialogOpen(false);
      setBulkDeleteWriteBack(false);
    }
  }, [selectedTags, bulkDeleteWriteBack]);

  // ─── Single Delete with write-back option ───────────────────────────
  const [deleteWriteBack, setDeleteWriteBack] = useState(false);

  const handleDeleteTagWithWriteBack = useCallback(async (tag: ReviewTag) => {
    setActionLoading(tag.id);
    try {
      if (deleteWriteBack) {
        const wbRes = await fetch('/api/tags/remove-from-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagId: tag.id }),
        });
        if (wbRes.ok) {
          const wbResult = await wbRes.json();
          if (wbResult.errors?.length > 0) {
            toast.warning(`Removed from ${wbResult.removed} source task(s), but ${wbResult.errors.length} failed`);
          }
        } else {
          toast.warning('Source removal failed — removing from Mission Control only');
        }
      }
      const response = await fetch(`/api/tags?id=${encodeURIComponent(tag.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAllTags(prev => prev.filter(t => t.id !== tag.id));
      setSelectedTagIds(prev => { const next = new Set(prev); next.delete(tag.id); return next; });
      toast.success(`"${tag.name}" removed`);
    } catch {
      toast.error('Failed to remove tag');
    } finally {
      setActionLoading(null);
      setDeleteDialogTag(null);
      setDeleteWriteBack(false);
    }
  }, [deleteWriteBack]);

  // ─── Tag source helper ──────────────────────────────────────────────

  const getTagSourceLabel = useCallback((tag: ReviewTag) => {
    const sources = tag.sources?.length ? tag.sources : (tag.source ? [tag.source] : []);
    if (sources.length === 0) return tag.type === 'hub' ? 'Hub' : 'Local';
    return sources.map(s => connectorTypeLabel(s)).join(', ');
  }, [connectorTypeLabel]);

  const getTagSourceIcon = useCallback((tag: ReviewTag) => {
    const sources = tag.sources?.length ? tag.sources : (tag.source ? [tag.source] : []);
    if (sources.length === 0) return null;
    return sources[0];
  }, []);

  const getTagSourceDetail = useCallback((tag: ReviewTag) => {
    const sourceLabel = getTagSourceLabel(tag);
    return tag.sourceNames?.length
      ? `${sourceLabel} · ${tag.sourceNames.join(', ')}`
      : sourceLabel;
  }, [getTagSourceLabel]);

  // ─── Export CSV ─────────────────────────────────────────────────────
  const handleExportCsv = useCallback(() => {
    // Sanitize cell values to prevent CSV formula injection (CWE-1236)
    const csvSafe = (val: string) => {
      const escaped = val.replace(/"/g, '""');
      // Prefix formula-triggering chars with a tab to prevent spreadsheet interpretation
      if (/^[=+\-@]/.test(escaped)) return `"\t${escaped}"`;
      return `"${escaped}"`;
    };
    const tagsToExport = filteredUserTags.length > 0 ? filteredUserTags : userTags;
    const rows = [
      ['Name', 'Slug', 'Type', 'Source', 'Color', 'Usage Count', 'System Tag'].join(','),
      ...tagsToExport.map(tag => [
        csvSafe(tag.name),
        csvSafe(tag.slug),
        csvSafe(tag.type),
        csvSafe(getTagSourceLabel(tag)),
        csvSafe(tag.color || ''),
        tag.usageCount,
        isSystemTag(tag.name) ? 'Yes' : 'No',
      ].join(',')),
    ];
    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mission-control-tags-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${tagsToExport.length} tags`);
  }, [filteredUserTags, userTags, getTagSourceLabel]);

  // ─── Render ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--text-muted)] py-12">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">Loading tags...</span>
      </div>
    );
  }

  const COLOR_PRESETS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280', '#14b8a6', '#f43f5e'];

  return (
    <div className="h-full min-h-0 flex flex-col">
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2 flex-shrink-0">Tags</h2>
      <p className="text-sm text-[var(--text-tertiary)] mb-4 flex-shrink-0">
        Filter by source, then select tags to merge, rename, recolor, remove, or view their tasks.
      </p>

      <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex-1 min-h-0 flex flex-col gap-4">
        {/* ── Merge Suggestions Banner ────────────────────────────────── */}
        {mergeSuggestions.length > 0 && (
          <motion.div variants={fadeSlideUp} className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-amber-900/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Zap size={13} className="text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => setSuggestionsExpanded(expanded => !expanded)}
                  aria-expanded={suggestionsExpanded}
                  aria-controls="tag-merge-suggestions"
                  className="flex w-full items-start justify-between gap-3 text-left"
                >
                  <span>
                    <span className="block text-sm font-medium text-amber-300">
                      {mergeSuggestions.length} potential duplicate{mergeSuggestions.length > 1 ? 's' : ''} found
                    </span>
                    <span className="mt-0.5 block text-[11px] text-amber-300/70">
                      Review a suggestion before any tags or task assignments change.
                    </span>
                  </span>
                  <ChevronDown
                    size={15}
                    className={`mt-0.5 flex-shrink-0 text-amber-400 transition-transform ${suggestionsExpanded ? '' : '-rotate-90'}`}
                  />
                </button>
                {suggestionsExpanded && <div id="tag-merge-suggestions" className="mt-2 space-y-1.5">
                  {mergeSuggestions.slice(0, 3).map(({ a, b }, idx) => (
                   <div key={idx} className="flex flex-wrap items-center gap-2 text-xs text-amber-300/80">
                     <span className="inline-flex items-center gap-1.5">
                       <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-amber-800/30" style={getTagPillStyle(a.color)}>
                         {a.name}
                       </span>
                       <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]" title={getTagSourceDetail(a)}>
                         {getTagSourceIcon(a) && <ConnectorBrandIcon type={getTagSourceIcon(a)!} size={10} />}
                         {getTagSourceDetail(a)}
                       </span>
                     </span>
                     <span className="text-[var(--text-muted)]">≈</span>
                     <span className="inline-flex items-center gap-1.5">
                       <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-amber-800/30" style={getTagPillStyle(b.color)}>
                         {b.name}
                       </span>
                       <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]" title={getTagSourceDetail(b)}>
                         {getTagSourceIcon(b) && <ConnectorBrandIcon type={getTagSourceIcon(b)!} size={10} />}
                         {getTagSourceDetail(b)}
                       </span>
                     </span>
                     <button
                       type="button"
                       onClick={() => openMergeSuggestion(a, b)}
                       className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
                     >
                       Review
                     </button>
                   </div>
                 ))}
                 {mergeSuggestions.length > 3 && (
                   <p className="text-[10px] text-amber-300/60">
                     And {mergeSuggestions.length - 3} more suggestions in the tag list below.
                   </p>
                 )}
                </div>}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Main Panel ─────────────────────────────────────────────── */}
        <motion.div variants={fadeSlideUp} className="flex-1 min-h-0 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl overflow-hidden">
          <div className="flex h-full min-h-0">
            {/* ── Scope Sidebar ──────────────────────────────────────── */}
            <aside aria-label="Filter tags by source" className="w-48 flex-shrink-0 overflow-y-auto overflow-x-hidden border-r border-[var(--border)] p-4 sm:w-56 xl:w-64">
              <div className="mb-2 flex items-center gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Sources</p>
                <Tooltip content="Choose where a tag is used. Connector rows include every list or repository for that source.">
                  <button type="button" aria-label="About source scope" className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                    <CircleHelp size={11} />
                  </button>
                </Tooltip>
              </div>
              <div className="space-y-1">
                <SidebarNavItem
                  icon={<Globe size={14} className="text-blue-400" />}
                  label="All Sources"
                  count={userTags.length}
                  active={scopeFilter === 'all'}
                  onClick={() => setScopeFilter('all')}
                  showZeroCount
                />

                {scopeOptions.sources.map(source => {
                  const sourceLists = scopeOptions.listsByType.get(source) ?? [];
                  const isExpanded = expandedScopeSources.has(source);
                  const activeSourceList = scopeFilter.startsWith('list:')
                    ? sourceLists.find(sourceList => `list:${sourceList.id}` === scopeFilter)
                    : undefined;
                  const hasHiddenActiveList = !!activeSourceList && !isExpanded;
                  const sourceTagCount = userTags.filter(t => {
                    const tagSources = t.sources?.length ? t.sources : (t.source ? [t.source] : []);
                    return tagSources.includes(source);
                  }).length;

                  return (
                  <React.Fragment key={source}>
                    <SidebarNavItem
                      icon={<ConnectorBrandIcon type={source} size={14} />}
                      label={connectorTypeLabel(source)}
                      count={sourceTagCount}
                      active={scopeFilter === source}
                      showZeroCount
                      suffix={hasHiddenActiveList ? (
                        <span
                          className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent)]"
                          title={`${activeSourceList.name} is still filtering tags`}
                        />
                      ) : undefined}
                      onClick={() => {
                        setScopeFilter(source);
                        if (sourceLists.length > 0) {
                          setExpandedScopeSources(previous => {
                            const next = new Set(previous);
                            next.add(source);
                            return next;
                          });
                        }
                      }}
                      action={sourceLists.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedScopeSources(previous => {
                              const next = new Set(previous);
                              if (next.has(source)) next.delete(source);
                              else next.add(source);
                              return next;
                            });
                          }}
                          className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                          aria-label={isExpanded ? `Collapse ${connectorTypeLabel(source)} lists` : `Expand ${connectorTypeLabel(source)} lists`}
                          aria-expanded={isExpanded}
                          title={isExpanded ? 'Collapse lists' : 'Expand lists'}
                        >
                          {isExpanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
                        </button>
                      ) : undefined}
                    />
                    {/* Per-source-list sub-items */}
                    {isExpanded && sourceLists.map(sl => (
                      <button
                        key={sl.id}
                        type="button"
                        onClick={() => setScopeFilter(`list:${sl.id}`)}
                        className={`grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md py-1.5 pl-7 pr-2.5 text-[11px] transition-colors ${
                          scopeFilter === `list:${sl.id}`
                            ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                            : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)]'
                        }`}
                      >
                        <ChevronRight size={9} className="opacity-40 flex-shrink-0" />
                        <span className="truncate text-left">{sl.name}</span>
                        <span className="text-[10px] tabular-nums text-[var(--text-muted)]">
                          {userTags.filter(tag => tag.listUsage?.some(usage =>
                            usage.connectorInstanceId === sl.connectorInstanceId
                            && usage.sourceListId === sl.sourceId
                          )).length}
                        </span>
                      </button>
                    ))}
                  </React.Fragment>
                  );
                })}

                <SidebarNavItem
                  icon={<TagIcon size={14} />}
                  label="Hub / Local"
                  count={userTags.filter(t => !t.sources?.length && !t.source).length}
                  active={scopeFilter === 'local'}
                  onClick={() => setScopeFilter('local')}
                  showZeroCount
                />
              </div>

              {/* System Tags */}
              {systemTags.length > 0 && (
                <div className="mt-5 pt-4 border-t border-[var(--border)]">
                  <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2 px-2">System Tags</p>
                  <div className="space-y-1">
                    {systemTags.map(tag => (
                      <div key={tag.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Lock size={9} className="text-[var(--text-muted)] opacity-50 flex-shrink-0" />
                          <span className="truncate">{tag.name}</span>
                        </span>
                        <span className="text-[10px] tabular-nums flex-shrink-0">{tag.usageCount}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </aside>

            {/* ── Tag List Area ──────────────────────────────────────── */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Toolbar */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-0)]/50">
                <div className="flex-1 relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Filter tags..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--surface-1)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/40 focus:border-blue-500/40"
                  />
                </div>
                <Select value={sortBy} onValueChange={v => setSortBy(v as typeof sortBy)}>
                  <SelectTrigger className="h-[30px] min-w-[140px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="usage-desc">Most used</SelectItem>
                    <SelectItem value="usage-asc">Least used</SelectItem>
                    <SelectItem value="name-asc">Name A→Z</SelectItem>
                    <SelectItem value="name-desc">Name Z→A</SelectItem>
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="inline-flex items-center gap-1 px-2 py-1.5 text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] transition-colors"
                  title="Export tags as CSV"
                >
                  <Download size={11} /> CSV
                </button>
              </div>

              {/* Table Header */}
              <div className="flex items-center gap-3 px-4 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border)]">
                <div className="w-5 flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={filteredUserTags.length > 0 && selectedTagIds.size === filteredUserTags.length}
                    onChange={toggleSelectAll}
                    aria-label="Select all visible tags"
                    className="rounded border-[var(--border)] w-3.5 h-3.5 accent-blue-500"
                  />
                </div>
                <div className="flex-1">Tag</div>
                <div className="flex w-28 items-center justify-end gap-1">
                  Tasks
                  <Tooltip content="With a source selected, this shows tasks in that source first and the total across all sources in parentheses.">
                    <button type="button" aria-label="About task counts" className="normal-case text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                      <CircleHelp size={10} />
                    </button>
                  </Tooltip>
                </div>
                <div className="flex w-32 items-center justify-center gap-1">
                  Source
                  <Tooltip content="The connector, repository, or list where this tag is currently used. Hub / Local tags are managed only in Mission Control.">
                    <button type="button" aria-label="About tag sources" className="normal-case text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                      <CircleHelp size={10} />
                    </button>
                  </Tooltip>
                </div>
                <div className="w-12 text-center">Color</div>
                <div className="w-24 text-right">Actions</div>
              </div>

              {/* Tag Rows */}
              <div role="region" aria-label="Tag list" tabIndex={0} className="flex-1 min-h-0 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500/50">
                {filteredUserTags.length === 0 && (
                  <div className="flex items-center justify-center py-12 text-sm text-[var(--text-muted)]">
                    {searchQuery ? 'No tags match your search' : 'No tags found'}
                  </div>
                )}

                <motion.div variants={staggerContainer} initial="hidden" animate="show">
                  {filteredUserTags.map(tag => {
                    const isSelected = selectedTagIds.has(tag.id);
                    const isMcOnly = tag.type === 'hub' && !sourceTagSlugs.has(tag.slug);
                    const suggestion = mergeSuggestions.find(s => s.a.id === tag.id || s.b.id === tag.id);
                    const scopedUsageCount = getScopedUsageCount(tag, scopeFilter, connectorSourceLists);
                    const showsScopedCount = scopeFilter !== 'all' && scopeFilter !== 'local';

                    return (
                      <motion.div
                        key={tag.id}
                        variants={fadeSlideUp}
                        className={`flex items-center gap-3 px-4 py-2 transition-colors group cursor-pointer ${
                          isSelected
                            ? 'bg-blue-500/10'
                            : 'hover:bg-[var(--surface-2)]/50'
                        }`}
                        onClick={() => toggleSelect(tag.id)}
                      >
                        <div className="w-5 flex items-center justify-center" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(tag.id)}
                            aria-label={`Select ${tag.name}`}
                            className="rounded border-[var(--border)] w-3.5 h-3.5 accent-blue-500"
                          />
                        </div>

                        <div className="flex-1 flex items-center gap-2 min-w-0">
                          <span
                            className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full border border-[var(--border)]"
                            style={getTagPillStyle(tag.color)}
                          >
                            {tag.name}
                          </span>
                          {isMcOnly && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/30 uppercase tracking-wide">
                              MC only
                            </span>
                          )}
                          {tag.unifiedInto && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-400 border border-blue-800/30 flex items-center gap-0.5">
                              <Link2 size={8} /> unified
                            </span>
                          )}
                          {suggestion && (
                            <button
                              type="button"
                              onClick={event => {
                                event.stopPropagation();
                                const counterpart = suggestion.a.id === tag.id ? suggestion.b : suggestion.a;
                                openMergeSuggestion(tag, counterpart);
                              }}
                              className="text-[9px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-400 border border-amber-800/30 inline-flex items-center gap-0.5 hover:bg-amber-900/50 hover:text-amber-300 transition-colors"
                              aria-label={`Merge with ${suggestion.a.id === tag.id ? suggestion.b.name : suggestion.a.name}`}
                              title={`Start merge workflow with ${suggestion.a.id === tag.id ? getTagSourceDetail(suggestion.b) : getTagSourceDetail(suggestion.a)}`}
                            >
                              <Merge size={8} />
                              Merge with {suggestion.a.id === tag.id ? suggestion.b.name : suggestion.a.name}
                            </button>
                          )}
                        </div>

                        <div
                          className="w-28 text-right text-xs text-[var(--text-secondary)] tabular-nums font-medium"
                          title={showsScopedCount ? `${scopedUsageCount} in selected source; ${tag.usageCount} across all sources` : `${tag.usageCount} tasks`}
                        >
                          {showsScopedCount ? (
                            <>
                              {scopedUsageCount}
                              <span className="ml-1 font-normal text-[var(--text-muted)]">({tag.usageCount} all)</span>
                            </>
                          ) : tag.usageCount}
                        </div>

                        <div className="w-32 text-center min-w-0">
                          {getTagSourceIcon(tag) ? (
                          <span className="inline-flex max-w-full items-center gap-1 text-[10px] text-[var(--text-muted)]" title={getTagSourceDetail(tag)}>
                              <ConnectorBrandIcon type={getTagSourceIcon(tag)!} size={12} />
                            <span className="truncate">{getTagSourceLabel(tag)}</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-[var(--text-muted)]">{getTagSourceLabel(tag)}</span>
                          )}
                        </div>

                        <div className="w-12 flex justify-center">
                          {tag.color && (
                            <button
                              type="button"
                              className="h-4 w-4 cursor-pointer rounded-full border border-[var(--border)] transition-transform hover:scale-110"
                              style={{ background: tag.color }}
                              onClick={e => { e.stopPropagation(); setRecolorTag(tag); setRecolorValue(tag.color || '#6b7280'); }}
                              title="Change color"
                              aria-label={`Recolor ${tag.name}`}
                            />
                          )}
                        </div>

                        <div className="w-24 flex justify-end" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            {tag.usageCount > 0 && (
                              <button
                                type="button"
                                onClick={() => handleViewTasks(tag)}
                                className="p-1 rounded text-[var(--text-muted)] hover:text-blue-400 hover:bg-[var(--surface-2)]"
                                title="View tasks"
                                aria-label={`View tasks tagged ${tag.name}`}
                              >
                                <Eye size={11} />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => { setRenameTag(tag); setRenameValue(tag.name); }}
                              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
                              title="Rename"
                              aria-label={`Rename ${tag.name}`}
                            >
                              <Pencil size={11} />
                            </button>
                            {isMcOnly && pushableSourceLists.length > 0 && (
                              <button
                                type="button"
                                onClick={() => { setPushDialogTag(tag); setPushTargetListId(''); }}
                                className="p-1 rounded text-[var(--text-muted)] hover:text-blue-400 hover:bg-[var(--surface-2)]"
                                title="Push to source"
                                aria-label={`Push ${tag.name} to source`}
                              >
                                <ExternalLink size={11} />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setDeleteDialogTag(tag)}
                              className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--surface-2)]"
                              title="Remove"
                              aria-label={`Remove ${tag.name}`}
                            >
                              {actionLoading === tag.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </motion.div>

                {/* System Tags Section */}
                {systemTags.length > 0 && scopeFilter === 'all' && !searchQuery && (
                  <div className="border-t border-[var(--border)] mt-2 pt-2 px-4 pb-2 opacity-60">
                    <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5 flex items-center gap-1">
                      <Lock size={9} /> System-managed (read-only)
                    </p>
                    {systemTags.map(tag => (
                      <div key={tag.id} className="flex items-center gap-3 py-1.5">
                        <div className="w-5"></div>
                        <div className="flex-1 flex items-center gap-2">
                          <span
                            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-[var(--border)]"
                            style={getTagPillStyle(tag.color)}
                          >
                            <Lock size={8} className="opacity-50" /> {tag.name}
                          </span>
                          <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-muted)] uppercase tracking-wide">
                            {getSystemCategory(tag.name) || 'system'}
                          </span>
                        </div>
                        <div className="w-28 text-right text-xs text-[var(--text-muted)] tabular-nums">{tag.usageCount}</div>
                        <div className="w-32"></div>
                        <div className="w-12"></div>
                        <div className="w-24"></div>
                      </div>
                    ))}
                  </div>
                )}

                {aiTags.length > 0 && (
                  <div className="border-t border-[var(--border)] p-4">
                    <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
                      AI-Inferred Tags ({aiTags.length})
                      <span className="text-xs font-normal text-[var(--text-muted)]">— suggested by AI, confirm to keep</span>
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {aiTags.map(tag => (
                        <span
                          key={tag.id}
                          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-dashed border-amber-800/30 bg-amber-900/20 text-amber-300"
                        >
                          <Zap size={9} /> {tag.name}
                          <span className="text-xs opacity-60 tabular-nums">({tag.usageCount})</span>
                          <button
                            type="button"
                            disabled={actionLoading === tag.id}
                            onClick={() => void handleConfirmAiTag(tag.id)}
                            className="ml-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                            title="Confirm"
                          >
                            {actionLoading === tag.id ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                          </button>
                          <button
                            type="button"
                            disabled={actionLoading === tag.id}
                            onClick={() => void handleDeleteTag(tag)}
                            className="text-red-400 hover:text-red-300 disabled:opacity-40"
                            title="Dismiss"
                          >
                            {actionLoading === tag.id ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={11} />}
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {confirmedAiTags.length > 0 && (
                  <div className="border-t border-[var(--border)] p-4">
                    <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
                      Confirmed AI Tags ({confirmedAiTags.length})
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {confirmedAiTags.map(tag => (
                        <span
                          key={tag.id}
                          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-[var(--border)]"
                          style={getTagPillStyle(tag.color)}
                        >
                          <CheckCircle2 size={9} className="text-emerald-400" />
                          {tag.name}
                          <span className="text-xs text-[var(--text-muted)] tabular-nums">({tag.usageCount})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Action Bar */}
              {selectedTags.length > 0 && (
                <div className="flex items-center gap-3 px-4 py-2.5 border-t border-[var(--border)] bg-[var(--surface-0)]/80">
                  <span className="text-xs text-[var(--text-muted)]">{selectedTags.length} selected</span>
                  <div className="flex items-center gap-1.5 ml-2">
                    <button
                      type="button"
                      onClick={openMergeDialog}
                      disabled={selectedTags.length < 2}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Merge size={11} /> Review Merge
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedTags.length === 1) { setDeleteDialogTag(selectedTags[0]); setDeleteWriteBack(false); }
                        else { setBulkDeleteDialogOpen(true); setBulkDeleteWriteBack(false); }
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded-md hover:bg-red-500/20 transition-colors"
                    >
                      <Trash2 size={11} /> Remove{selectedTags.length > 1 ? ` (${selectedTags.length})` : ''}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedTags.length === 1) { setRenameTag(selectedTags[0]); setRenameValue(selectedTags[0].name); }
                        else toast.error('Select a single tag to rename');
                      }}
                      disabled={selectedTags.length !== 1}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] bg-[var(--surface-1)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Pencil size={11} /> Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedTags.length === 1) { setRecolorTag(selectedTags[0]); setRecolorValue(selectedTags[0].color || '#6b7280'); }
                        else toast.error('Select a single tag to recolor');
                      }}
                      disabled={selectedTags.length !== 1}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] bg-[var(--surface-1)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Palette size={11} /> Recolor
                    </button>
                    {selectedTags.length === 1 && selectedTags[0].usageCount > 0 && (
                      <button
                        type="button"
                        onClick={() => handleViewTasks(selectedTags[0])}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] bg-[var(--surface-1)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] transition-colors"
                      >
                        <Eye size={11} /> View Tasks
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>

      </motion.div>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* DIALOGS                                                        */}
      {/* ═══════════════════════════════════════════════════════════════ */}

      {/* Delete Confirmation */}
      <AnimatePresence>
        {deleteDialogTag && (
          <>
            <motion.div
              variants={modalOverlay}
              initial="hidden" animate="show" exit="hidden"
              className="fixed inset-0 bg-black/60 z-50"
              onClick={() => { setDeleteDialogTag(null); setDeleteWriteBack(false); }}
            />
            <motion.div
              variants={modalContent}
              initial="hidden" animate="show" exit="hidden"
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl"
            >
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Remove tag?</h3>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                This removes &ldquo;{deleteDialogTag.name}&rdquo; and detaches it from {deleteDialogTag.usageCount} task{deleteDialogTag.usageCount === 1 ? '' : 's'}.
              </p>

              {/* Source write-back option — only show for source-linked tags */}
              {deleteDialogTag.type === 'source' && deleteDialogTag.usageCount > 0 && (
                <label className="flex items-start gap-2 bg-amber-900/20 border border-amber-800/30 rounded-md px-3 py-2.5 mb-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteWriteBack}
                    onChange={e => setDeleteWriteBack(e.target.checked)}
                    className="mt-0.5 rounded border-[var(--border)] w-3.5 h-3.5 accent-amber-500"
                  />
                  <div>
                    <span className="text-xs text-amber-300 font-medium">Also remove from source</span>
                    <p className="text-[10px] text-amber-300/70 mt-0.5">
                      Remove this label from {deleteDialogTag.usageCount} task{deleteDialogTag.usageCount === 1 ? '' : 's'} in the source system (e.g., GitHub).
                    </p>
                  </div>
                </label>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setDeleteDialogTag(null); setDeleteWriteBack(false); }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={actionLoading === deleteDialogTag.id}
                  onClick={() => void handleDeleteTagWithWriteBack(deleteDialogTag)}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                >
                  {actionLoading === deleteDialogTag.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Remove
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Merge / Unify Dialog */}
      {portalRoot && createPortal(
        <AnimatePresence>
          {mergeDialogOpen && (
            <>
            <motion.div
              variants={modalOverlay}
              initial="hidden" animate="show" exit="hidden"
              className="fixed inset-0 bg-black/60 z-50"
              onClick={closeMergeDialog}
            />
            <motion.div
              variants={modalContent}
              initial="hidden" animate="show" exit="hidden"
              role="dialog"
              aria-modal="true"
              aria-labelledby="merge-dialog-title"
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl"
            >
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-400">
                  Step {mergeStep} of 2
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">
                  {mergeReviewTags.length} tags
                </p>
              </div>

              {mergeStep === 1 ? (
                <>
                  <h3 id="merge-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                    Choose the tag to keep
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] mb-4">
                    Its name and color will represent the merged tags in Mission Control.
                  </p>

                  <div className="space-y-2 mb-4 max-h-48 overflow-y-auto pr-1">
                    {mergeReviewTags.map(tag => (
                      <button
                        key={tag.id}
                        type="button"
                        disabled={cannotUseAsMergeTarget(tag)}
                        onClick={() => setMergeTargetId(tag.id)}
                        className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                          mergeTargetId === tag.id
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50'
                        }`}
                        aria-pressed={mergeTargetId === tag.id}
                        title={cannotUseAsMergeTarget(tag)
                          ? 'The selected source tags have no task scope to detach from'
                          : undefined}
                      >
                        <span className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                          mergeTargetId === tag.id ? 'border-blue-400' : 'border-[var(--text-muted)]'
                        }`}>
                          {mergeTargetId === tag.id && <span className="w-2 h-2 rounded-full bg-blue-400" />}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border border-[var(--border)]" style={getTagPillStyle(tag.color)}>
                              {tag.name}
                            </span>
                            {tag.id === recommendedMergeTargetId && (
                              <span className="text-[9px] uppercase tracking-wide text-blue-400">Recommended</span>
                            )}
                          </span>
                          <span className="mt-1 block text-[10px] text-[var(--text-muted)]">
                            {getTagSourceDetail(tag)} · {tag.usageCount} task{tag.usageCount === 1 ? '' : 's'}
                          </span>
                          {cannotUseAsMergeTarget(tag) && (
                            <span className="mt-1 block text-[10px] text-amber-400">
                              Cannot keep this source tag because no selected source has a known task scope.
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="rounded-lg border border-blue-800/40 bg-blue-900/20 p-3 mb-4">
                    <span className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                      <Merge size={12} /> Merge in Mission Control
                    </span>
                    <span className="mt-1 block text-[10px] text-[var(--text-muted)]">
                      {mergeHasSourceTags
                        ? mergeTargetTag?.type === 'source'
                          ? 'On tasks using the selected source tags, duplicate Hub assignments will be detached. The Hub tag remains unchanged everywhere else.'
                          : 'The tags will appear as one in Mission Control. Source labels stay unchanged so sync keeps working.'
                        : 'Tasks will move to the tag you keep, and the other local tag records will be deleted.'}
                    </span>
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={closeMergeDialog}
                      className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!mergeTargetTag}
                      onClick={() => setMergeStep(2)}
                      className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Review Outcome
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h3 id="merge-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                    Review the outcome
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] mb-4">
                    Confirm exactly what will change before applying this action.
                  </p>

                  {mergeTargetTag && (
                    <div className="rounded-lg border border-blue-800/40 bg-blue-900/20 p-3 mb-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-400 mb-2">
                        What wins in Mission Control
                      </p>
                      <div className="flex items-center gap-2">
                        <CheckCircle2 size={13} className="text-emerald-400" />
                        <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border border-[var(--border)]" style={getTagPillStyle(mergeTargetTag.color)}>
                          {mergeTargetTag.name}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">{getTagSourceDetail(mergeTargetTag)}</span>
                      </div>
                      <p className="mt-2 text-[10px] text-blue-300/80">
                        Its name and color represent all selected tags in Mission Control.
                      </p>
                    </div>
                  )}

                  <div className="rounded-lg bg-[var(--surface-0)] p-3 mb-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-2">
                      Tag-by-tag outcome
                    </p>
                    <ul className="space-y-2">
                      {mergeReviewTags.map(tag => {
                        const isTarget = tag.id === mergeTargetId;
                        let outcome: string;
                        if (mergeMode === 'unify') {
                          if (isTarget) {
                            outcome = tag.type === 'source'
                              ? ` remains unchanged in ${getTagSourceDetail(tag)} and becomes the winning tag in Mission Control.`
                              : ' is kept as the winning Mission Control tag.';
                          } else {
                            outcome = tag.type === 'source'
                              ? ` remains unchanged in ${getTagSourceDetail(tag)} and links to the winning tag in Mission Control.`
                              : mergeTargetTag?.type === 'source'
                                ? ' is detached only from tasks using the selected source tags and remains unchanged elsewhere.'
                                : ' is removed from Mission Control and its task assignments move to the winning tag.';
                          }
                        } else {
                          outcome = isTarget
                            ? ' is kept as the winning Mission Control tag.'
                            : ' is removed from Mission Control and its task assignments move to the winning tag.';
                        }
                        return (
                          <li key={tag.id} className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                            {isTarget
                              ? <CheckCircle2 size={11} className="mt-0.5 text-emerald-400 flex-shrink-0" />
                              : mergeMode === 'unify'
                                ? <Link2 size={11} className="mt-0.5 text-blue-400 flex-shrink-0" />
                                : <Trash2 size={11} className="mt-0.5 text-red-400 flex-shrink-0" />}
                            <span>
                              <strong className="text-[var(--text-primary)]">{tag.name}</strong>
                              {outcome}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setMergeStep(1)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      disabled={!mergeTargetId || mergeLoading}
                      onClick={() => void handleMerge()}
                      className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                    >
                      {mergeLoading ? <Loader2 size={12} className="animate-spin" /> : <Merge size={12} />}
                      Merge Tags
                    </button>
                  </div>
                </>
              )}
            </motion.div>
            </>
          )}
        </AnimatePresence>,
        portalRoot,
      )}

      {/* Rename Dialog */}
      <AnimatePresence>
        {renameTag && (
          <>
            <motion.div
              variants={modalOverlay}
              initial="hidden" animate="show" exit="hidden"
              className="fixed inset-0 bg-black/60 z-50"
              onClick={() => setRenameTag(null)}
            />
            <motion.div
              variants={modalContent}
              initial="hidden" animate="show" exit="hidden"
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl"
            >
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Rename Tag</h3>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                Rename &ldquo;{renameTag.name}&rdquo; across {renameTag.usageCount} task{renameTag.usageCount === 1 ? '' : 's'}.
              </p>

              <input
                type="text"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleRename(); }}
                placeholder="New name..."
                autoFocus
                className="w-full px-3 py-2 text-sm bg-[var(--surface-0)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/40 focus:border-blue-500/40 mb-4"
              />

              {renameTag.type === 'source' && (
                <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/30 rounded-md px-2.5 py-1.5 mb-4">
                  ⚠️ Source tags can only be renamed in Mission Control. The original label on the source system will not change.
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRenameTag(null)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!renameValue.trim() || renameValue.trim() === renameTag.name || renameLoading}
                  onClick={() => void handleRename()}
                  className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                >
                  {renameLoading ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
                  Rename
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Recolor Dialog */}
      <AnimatePresence>
        {recolorTag && (
          <>
            <motion.div
              variants={modalOverlay}
              initial="hidden" animate="show" exit="hidden"
              className="fixed inset-0 bg-black/60 z-50"
              onClick={() => setRecolorTag(null)}
            />
            <motion.div
              variants={modalContent}
              initial="hidden" animate="show" exit="hidden"
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-xs bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl"
            >
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Change Color</h3>
              <div className="flex items-center gap-3 mb-4">
                <span
                  className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full border border-[var(--border)]"
                  style={getTagPillStyle(recolorValue)}
                >
                  {recolorTag.name}
                </span>
                <span className="text-xs text-[var(--text-muted)]">Preview</span>
              </div>

              <div className="grid grid-cols-5 gap-2 mb-4">
                {COLOR_PRESETS.map(color => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setRecolorValue(color)}
                    className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${
                      recolorValue === color ? 'border-white scale-110' : 'border-transparent'
                    }`}
                    style={{ background: color }}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2 mb-4">
                <label className="text-xs text-[var(--text-muted)]">Custom:</label>
                <input
                  type="color"
                  value={recolorValue}
                  onChange={e => setRecolorValue(e.target.value)}
                  className="w-8 h-8 rounded border-0 cursor-pointer bg-transparent"
                />
                <span className="text-xs text-[var(--text-muted)] font-mono">{recolorValue}</span>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRecolorTag(null)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={recolorLoading}
                  onClick={() => void handleRecolor()}
                  className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                >
                  {recolorLoading ? <Loader2 size={12} className="animate-spin" /> : <Palette size={12} />}
                  Apply
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Push-to-Source Dialog */}
      <AnimatePresence>
        {pushDialogTag && (
          <>
            <motion.div
              variants={modalOverlay}
              initial="hidden" animate="show" exit="hidden"
              className="fixed inset-0 bg-black/60 z-50"
              onClick={() => { setPushDialogTag(null); setPushTargetListId(''); }}
            />
            <motion.div
              variants={modalContent}
              initial="hidden" animate="show" exit="hidden"
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl"
            >
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                Push &ldquo;{pushDialogTag.name}&rdquo; to source
              </h3>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                Create this tag/label in a source system so it can be applied to tasks there.
              </p>
              <label className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1 block">Target</label>
              <Select value={pushTargetListId} onValueChange={v => setPushTargetListId(v)}>
                <SelectTrigger className="h-9 w-full mb-4">
                  <SelectValue placeholder="Select a source list..." />
                </SelectTrigger>
                <SelectContent>
                  {pushableSourceLists.map(sl => (
                    <SelectItem key={sl.id} value={sl.id}>{sl.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setPushDialogTag(null); setPushTargetListId(''); }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!pushTargetListId || pushLoading}
                  onClick={() => void handlePushTag()}
                  className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                >
                  {pushLoading ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
                  Push
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Bulk Delete Dialog */}
      <AnimatePresence>
        {bulkDeleteDialogOpen && (
          <>
            <motion.div
              variants={modalOverlay}
              initial="hidden" animate="show" exit="hidden"
              className="fixed inset-0 bg-black/60 z-50"
              onClick={() => { setBulkDeleteDialogOpen(false); setBulkDeleteWriteBack(false); }}
            />
            <motion.div
              variants={modalContent}
              initial="hidden" animate="show" exit="hidden"
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl"
            >
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Remove {selectedTags.length} tags?</h3>
              <p className="text-xs text-[var(--text-muted)] mb-3">
                This will remove the following tags and detach them from all linked tasks:
              </p>

              <div className="bg-[var(--surface-0)] rounded-lg p-3 mb-4 max-h-32 overflow-y-auto">
                <div className="flex flex-wrap gap-1.5">
                  {selectedTags.filter(t => !isSystemTag(t.name)).map(tag => (
                    <span
                      key={tag.id}
                      className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full border border-[var(--border)]"
                      style={getTagPillStyle(tag.color)}
                    >
                      {tag.name} <span className="text-[var(--text-muted)] ml-1">({tag.usageCount})</span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Source write-back option */}
              {selectedTags.some(t => t.type === 'source' && t.usageCount > 0) && (
                <label className="flex items-start gap-2 bg-amber-900/20 border border-amber-800/30 rounded-md px-3 py-2.5 mb-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bulkDeleteWriteBack}
                    onChange={e => setBulkDeleteWriteBack(e.target.checked)}
                    className="mt-0.5 rounded border-[var(--border)] w-3.5 h-3.5 accent-amber-500"
                  />
                  <div>
                    <span className="text-xs text-amber-300 font-medium">Also remove from source</span>
                    <p className="text-[10px] text-amber-300/70 mt-0.5">
                      Remove labels from tasks in the source system (e.g., GitHub) before deleting.
                    </p>
                  </div>
                </label>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setBulkDeleteDialogOpen(false); setBulkDeleteWriteBack(false); }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={bulkDeleteLoading}
                  onClick={() => void handleBulkDelete()}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                >
                  {bulkDeleteLoading ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Remove {selectedTags.filter(t => !isSystemTag(t.name)).length} Tags
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export { TagReviewPanel };
