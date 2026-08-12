'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import {
  Loader2, Zap, ExternalLink, X, CheckCircle2, XCircle,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  staggerContainer, fadeSlideUp, modalOverlay, modalContent,
} from '@/lib/motion';
import { getTagPillStyle } from '@/lib/constants/colors';
import { settingsLogger } from '@/lib/client-logger';
import { CONNECTOR_TYPES } from './types';
import { ConnectorBrandIcon } from './ConnectorBrandIcon';

function TagsSection() {
  type SettingsTag = {
    id: string;
    name: string;
    slug: string;
    type: string;
    source: string | null;
    sources: string[];
    color: string | null;
    confirmed: boolean;
    usageCount: number;
  };

  type SourceListInfo = {
    id: string;
    connectorInstanceId: string;
    sourceId: string;
    name: string;
    type: string;
  };

  type ConnectorInfo = {
    id: string;
    type: string;
    name: string;
    capabilities: { tagCreationMode?: string; tagScope?: string; tagWriteBack?: boolean };
  };

  const [tags, setTags] = useState<SettingsTag[]>([]);
  const [sourceTagSlugs, setSourceTagSlugs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'usage-desc' | 'usage-asc' | 'name-asc' | 'name-desc'>('usage-desc');
  const [groupBySource, setGroupBySource] = useState(false);
  const [showMcOnly, setShowMcOnly] = useState(false);
  const [tagActionId, setTagActionId] = useState<string | null>(null);
  const [deleteDialogTag, setDeleteDialogTag] = useState<SettingsTag | null>(null);
  const [pushDialogTag, setPushDialogTag] = useState<SettingsTag | null>(null);
  const [pushTargetListId, setPushTargetListId] = useState<string>('');
  const [pushLoading, setPushLoading] = useState(false);
  const [connectorSourceLists, setConnectorSourceLists] = useState<SourceListInfo[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);

  const connectorTypeLabels = useMemo(
    () => new Map(CONNECTOR_TYPES.map((item) => [item.type, item.name])),
    []
  );

  const connectorTypeLabel = useCallback((source: string) => {
    const label = connectorTypeLabels.get(source);
    if (label) return label;
    return source
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }, [connectorTypeLabels]);

  const getTagSources = useCallback((tag: SettingsTag) => {
    if (Array.isArray(tag.sources) && tag.sources.length > 0) return tag.sources;
    if (tag.source) return [tag.source];
    return [];
  }, []);

  const sortTagList = useCallback((list: SettingsTag[]) => {
    const next = [...list];
    next.sort((a, b) => {
      if (sortBy === 'usage-desc') return b.usageCount - a.usageCount;
      if (sortBy === 'usage-asc') return a.usageCount - b.usageCount;
      if (sortBy === 'name-desc') return b.name.localeCompare(a.name);
      return a.name.localeCompare(b.name);
    });
    return next;
  }, [sortBy]);

  const refreshTags = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/tags');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setTags(Array.isArray(data.tags) ? data.tags : []);
      setSourceTagSlugs(new Set(Array.isArray(data.sourceTagSlugs) ? data.sourceTagSlugs : []));
    } catch {
      toast.error('Failed to load tags');
      setTags([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTags();
  }, [refreshTags]);

  // Fetch connector + source list info for the push-to-source feature
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

  // Source lists whose connector supports creating tags (tagWriteBack + predefined)
  const pushableSourceLists = useMemo(() => {
    return connectorSourceLists.filter((sl) => {
      const conn = connectors.find((c) => c.id === sl.connectorInstanceId);
      return conn?.capabilities?.tagWriteBack;
    });
  }, [connectorSourceLists, connectors]);

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
  }, [pushDialogTag, pushTargetListId]);

  const runTagAction = useCallback(async (tagId: string, action: () => Promise<void>) => {
    setTagActionId(tagId);
    try {
      await action();
    } catch {
      toast.error('Failed to update tag');
    } finally {
      setTagActionId(null);
    }
  }, []);

  const handleConfirmAiTag = useCallback(async (tagId: string) => {
    await runTagAction(tagId, async () => {
      const response = await fetch('/api/tags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tagId, confirmed: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setTags((prev) => prev.map((tag) => (tag.id === tagId ? { ...tag, confirmed: true } : tag)));
      toast.success('Tag confirmed');
    });
  }, [runTagAction]);

  const handleDeleteTag = useCallback(async (tag: SettingsTag, successMessage: string) => {
    await runTagAction(tag.id, async () => {
      const response = await fetch(`/api/tags?id=${encodeURIComponent(tag.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setTags((prev) => prev.filter((item) => item.id !== tag.id));
      toast.success(successMessage);
    });
  }, [runTagAction]);

  const sourceFilteredTags = tags.filter((tag) => (
    sourceFilter === 'all' || getTagSources(tag).includes(sourceFilter)
  ));

  const sourceTags = sortTagList(sourceFilteredTags.filter((tag) => tag.type === 'source'));
  const hubTagsAll = sortTagList(sourceFilteredTags.filter((tag) => tag.type === 'hub'));
  const hubTags = showMcOnly
    ? hubTagsAll.filter((tag) => !sourceTagSlugs.has(tag.slug))
    : hubTagsAll;
  const mcOnlyCount = hubTagsAll.filter((tag) => !sourceTagSlugs.has(tag.slug)).length;
  const aiTags = sortTagList(sourceFilteredTags.filter((tag) => tag.type === 'ai-inferred' && !tag.confirmed));
  const confirmedAiTags = sortTagList(sourceFilteredTags.filter((tag) => tag.type === 'ai-inferred' && tag.confirmed));

  const availableSources = Array.from(new Set(
    tags.flatMap((tag) => getTagSources(tag))
  )).sort((a, b) => connectorTypeLabel(a).localeCompare(connectorTypeLabel(b)));

  const sourceTagGroups = availableSources
    .map((source) => ({
      source,
      tags: sourceTags.filter((tag) => getTagSources(tag).includes(source)),
    }))
    .filter((group) => group.tags.length > 0);

  return (
    <>
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">Tags</h2>
      <p className="text-sm text-[var(--text-tertiary)] mb-6">
        Source tags are synced from connectors. Hub tags are yours to create and manage.
      </p>

      {loading ? (
        <div className="flex items-center justify-center gap-2 text-[var(--text-muted)] py-12">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading tags...</span>
        </div>
      ) : (
        <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-5">
          <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Filter by source</label>
                <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v)}>
                  <SelectTrigger className="h-9 min-w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    {availableSources.map((source) => (
                      <SelectItem key={source} value={source}>{connectorTypeLabel(source)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Sort</label>
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as 'usage-desc' | 'usage-asc' | 'name-asc' | 'name-desc')}>
                  <SelectTrigger className="h-9 min-w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="usage-desc">Most used</SelectItem>
                    <SelectItem value="usage-asc">Least used</SelectItem>
                    <SelectItem value="name-asc">Name A→Z</SelectItem>
                    <SelectItem value="name-desc">Name Z→A</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <button
                type="button"
                onClick={() => setGroupBySource((prev) => !prev)}
                className={`h-9 px-3 rounded-lg text-sm border transition-colors md:self-end ${groupBySource
                  ? 'border-blue-500/50 bg-blue-500/15 text-blue-300'
                  : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Group source tags by source
              </button>
            </div>
          </motion.div>

          {/* Source Tags */}
          <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
              <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
              Source Tags ({sourceTags.length})
              <span className="text-xs font-normal text-[var(--text-muted)]">-- synced from connectors, read-only</span>
            </h3>
            {sourceTags.length === 0 && <span className="text-xs text-[var(--text-muted)] italic">No source tags synced yet</span>}
            {!groupBySource && (
              <div className="flex flex-wrap gap-2">
                {sourceTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border border-[var(--border)]"
                    style={getTagPillStyle(tag.color)}
                  >
                    {getTagSources(tag).map((src) => (
                      <ConnectorBrandIcon key={`${tag.id}-${src}`} type={src} size={14} />
                    ))}
                    {tag.name}
                    <span className="text-xs font-normal text-[var(--text-muted)] tabular-nums">({tag.usageCount})</span>
                  </span>
                ))}
              </div>
            )}
            {groupBySource && (
              <div className="space-y-4">
                {sourceTagGroups.map((group) => (
                  <div key={group.source} className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] uppercase tracking-wide">
                      <ConnectorBrandIcon type={group.source} size={14} />
                      <span>{connectorTypeLabel(group.source)}</span>
                      <span className="normal-case text-[var(--text-tertiary)]">({group.tags.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {group.tags.map((tag) => (
                        <span
                          key={`${group.source}-${tag.id}`}
                          className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border border-[var(--border)]"
                          style={getTagPillStyle(tag.color)}
                        >
                          {tag.name}
                          <span className="text-xs font-normal text-[var(--text-muted)] tabular-nums">({tag.usageCount})</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>

          {/* Hub Tags */}
          <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text-secondary)] flex items-center gap-2">
                <span className="w-2 h-2 bg-purple-500 rounded-full"></span>
                Hub Tags ({hubTags.length}{showMcOnly ? ` of ${hubTagsAll.length}` : ''})
                <span className="text-xs font-normal text-[var(--text-muted)]">-- your custom cross-source tags</span>
              </h3>
              {mcOnlyCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowMcOnly((prev) => !prev)}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${showMcOnly
                    ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                    : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  MC only ({mcOnlyCount})
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {hubTags.length === 0 && (
                <span className="text-xs text-[var(--text-muted)] italic">
                  {showMcOnly ? 'All hub tags exist in at least one source' : 'No hub tags created yet'}
                </span>
              )}
              {hubTags.map((tag) => {
                const isMcOnly = !sourceTagSlugs.has(tag.slug);
                return (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-[var(--border)] group"
                    style={getTagPillStyle(tag.color)}
                  >
                    {tag.name}
                    <span className="text-xs text-[var(--text-muted)] tabular-nums">({tag.usageCount})</span>
                    {isMcOnly && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/30 uppercase tracking-wide" title="This tag only exists in Mission Control — not synced to any source">
                        MC only
                      </span>
                    )}
                    {isMcOnly && pushableSourceLists.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setPushDialogTag(tag);
                          setPushTargetListId('');
                        }}
                        disabled={tagActionId === tag.id}
                        className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 text-blue-400 hover:text-blue-300 disabled:opacity-40"
                        title="Push tag to a source"
                      >
                        <ExternalLink size={11} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteDialogTag(tag);
                      }}
                      disabled={tagActionId === tag.id}
                      className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--text-muted)] hover:text-red-400 disabled:opacity-40"
                      title="Delete hub tag"
                    >
                      {tagActionId === tag.id ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
                    </button>
                  </span>
                );
              })}
            </div>
          </motion.div>

          {/* AI Tags */}
          {aiTags.length > 0 && (
            <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-dashed border-amber-800/40 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
                <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
                AI-Inferred Tags ({aiTags.length})
                <span className="text-xs font-normal text-[var(--text-muted)]">-- suggested by AI, confirm to keep</span>
              </h3>
              <div className="flex flex-wrap gap-2">
                {aiTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-dashed border-amber-800/30 bg-amber-900/20 text-amber-300"
                  >
                    <Zap size={9} /> {tag.name}
                    <span className="text-xs opacity-60 tabular-nums">({tag.usageCount})</span>
                    <button
                      type="button"
                      disabled={tagActionId === tag.id}
                      onClick={() => void handleConfirmAiTag(tag.id)}
                      className="ml-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                      title="Confirm"
                    >
                      {tagActionId === tag.id ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                    </button>
                    <button
                      type="button"
                      disabled={tagActionId === tag.id}
                      onClick={() => void handleDeleteTag(tag, 'AI tag dismissed')}
                      className="text-red-400 hover:text-red-300 disabled:opacity-40"
                      title="Dismiss"
                    >
                      {tagActionId === tag.id ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={11} />}
                    </button>
                  </span>
                ))}
              </div>
            </motion.div>
          )}

          {confirmedAiTags.length > 0 && (
            <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4">
              <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
                <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
                Confirmed AI Tags ({confirmedAiTags.length})
                <span className="text-xs font-normal text-[var(--text-muted)]">-- AI suggestions you approved</span>
              </h3>
              <div className="flex flex-wrap gap-2">
                {confirmedAiTags.map((tag) => (
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
            </motion.div>
          )}
        </motion.div>
      )}

      <ConfirmDialog
        open={Boolean(deleteDialogTag)}
        title="Delete hub tag?"
        message={deleteDialogTag ? `This removes the "${deleteDialogTag.name}" hub tag and detaches it from tasks.` : ''}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => {
          if (!deleteDialogTag) return;
          const tag = deleteDialogTag;
          setDeleteDialogTag(null);
          void handleDeleteTag(tag, 'Hub tag deleted');
        }}
        onCancel={() => setDeleteDialogTag(null)}
      />

      {/* Push-to-source dialog */}
      <AnimatePresence>
        {pushDialogTag && (
          <>
            <motion.div
              variants={modalOverlay}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="fixed inset-0 bg-black/60 z-50"
              onClick={() => { setPushDialogTag(null); setPushTargetListId(''); }}
            />
            <motion.div
              variants={modalContent}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl"
            >
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                Push &ldquo;{pushDialogTag.name}&rdquo; to source
              </h3>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                Create this tag/label in a source system so it can be applied to tasks there.
              </p>
              <label className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-1 block">
                Target
              </label>
              <Select value={pushTargetListId} onValueChange={(v) => setPushTargetListId(v)}>
                <SelectTrigger className="h-9 w-full mb-4">
                  <SelectValue placeholder="Select a source list..." />
                </SelectTrigger>
                <SelectContent>
                  {pushableSourceLists.map((sl) => (
                    <SelectItem key={sl.id} value={sl.id}>
                      {sl.name}
                    </SelectItem>
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
    </>
  );
}


export { TagsSection };
