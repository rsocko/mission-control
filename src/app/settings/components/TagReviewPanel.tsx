'use client';

import { useCallback, useMemo, useReducer, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { staggerContainer, fadeSlideUp } from '@/lib/motion';
import { CONNECTOR_TYPES } from './types';
import { BulkDeleteTagsDialog } from './tag-review/dialogs/BulkDeleteTagsDialog';
import { DeleteTagDialog } from './tag-review/dialogs/DeleteTagDialog';
import { MergeTagsDialog } from './tag-review/dialogs/MergeTagsDialog';
import { PushTagDialog } from './tag-review/dialogs/PushTagDialog';
import { RecolorTagDialog } from './tag-review/dialogs/RecolorTagDialog';
import { RenameTagDialog } from './tag-review/dialogs/RenameTagDialog';
import {
  CLOSED_TAG_DIALOG,
  tagDialogReducer,
  type TagDialogState,
} from './tag-review/dialog-state';
import {
  chooseDefaultMergeTarget,
  filterAndSortTags,
  findMergeSuggestions,
  getScopeOptions,
  partitionTags,
} from './tag-review/heuristics';
import { MergeSuggestions } from './tag-review/MergeSuggestions';
import { TagReviewFilters } from './tag-review/TagReviewFilters';
import { TagReviewList } from './tag-review/TagReviewList';
import type { MergeMode, ReviewTag, TagSort } from './tag-review/types';
import { useTagMutations } from './tag-review/useTagMutations';
import { useTagReviewData } from './tag-review/useTagReviewData';

function stateOfKind<K extends TagDialogState['kind']>(
  state: TagDialogState,
  kind: K,
): Extract<TagDialogState, { kind: K }> | null {
  return state.kind === kind ? state as Extract<TagDialogState, { kind: K }> : null;
}

function TagReviewPanel() {
  const router = useRouter();
  const {
    allTags,
    connectors,
    loading,
    pushableSourceLists,
    refreshTags,
    setAllTags,
    sourceLists,
    sourceTagSlugs,
  } = useTagReviewData();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<TagSort>('usage-desc');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(true);
  const [expandedScopeSources, setExpandedScopeSources] = useState<Set<string>>(new Set());
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [dialog, dispatchDialog] = useReducer(tagDialogReducer, CLOSED_TAG_DIALOG);

  const connectorTypeLabels = useMemo(
    () => new Map(CONNECTOR_TYPES.map(item => [item.type, item.name])),
    [],
  );
  const connectorTypeLabel = useCallback((source: string) =>
    connectorTypeLabels.get(source)
      || source.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
  [connectorTypeLabels]);

  const { userTags, systemTags, aiTags, confirmedAiTags } = useMemo(
    () => partitionTags(allTags),
    [allTags],
  );
  const scopeOptions = useMemo(
    () => getScopeOptions(allTags, sourceLists, connectors),
    [allTags, sourceLists, connectors],
  );
  const filteredTags = useMemo(
    () => filterAndSortTags(userTags, scopeFilter, searchQuery, sortBy, sourceLists),
    [userTags, scopeFilter, searchQuery, sortBy, sourceLists],
  );
  const mergeSuggestions = useMemo(() => findMergeSuggestions(userTags), [userTags]);
  const selectedTags = useMemo(
    () => userTags.filter(tag => selectedTagIds.has(tag.id)),
    [selectedTagIds, userTags],
  );
  const mergeState = stateOfKind(dialog, 'merge');
  const mergeReviewTags = useMemo(
    () => mergeState
      ? userTags.filter(tag => mergeState.tagIds.includes(tag.id))
      : [],
    [mergeState, userTags],
  );
  const mergeMode: MergeMode = mergeReviewTags.some(tag => tag.type === 'source')
    ? 'unify'
    : 'merge';

  const removeSelectedIds = useCallback((tagIds: string[]) => {
    setSelectedTagIds(previous => {
      const next = new Set(previous);
      for (const id of tagIds) next.delete(id);
      return next;
    });
  }, []);
  const mutations = useTagMutations({ refreshTags, setAllTags, removeSelectedIds });

  const toggleSelect = useCallback((tagId: string) => {
    setSelectedTagIds(previous => {
      const next = new Set(previous);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedTagIds(previous =>
      previous.size === filteredTags.length
        ? new Set()
        : new Set(filteredTags.map(tag => tag.id))
    );
  }, [filteredTags]);

  const openMerge = useCallback((tags: ReviewTag[], origin: 'selection' | 'suggestion') => {
    if (tags.length < 2) {
      toast.error('Select at least 2 tags to merge');
      return;
    }
    dispatchDialog({
      type: 'open-merge',
      tagIds: tags.map(tag => tag.id),
      targetId: chooseDefaultMergeTarget(tags).id,
      origin,
    });
  }, []);

  const getSourceLabel = useCallback((tag: ReviewTag) => {
    const sources = tag.sources?.length ? tag.sources : (tag.source ? [tag.source] : []);
    if (sources.length === 0) return tag.type === 'hub' ? 'Hub' : 'Local';
    return sources.map(connectorTypeLabel).join(', ');
  }, [connectorTypeLabel]);
  const getSourceIcon = useCallback((tag: ReviewTag) => {
    const sources = tag.sources?.length ? tag.sources : (tag.source ? [tag.source] : []);
    return sources[0] ?? null;
  }, []);
  const getSourceDetail = useCallback((tag: ReviewTag) => {
    const label = getSourceLabel(tag);
    return tag.sourceNames?.length ? `${label} · ${tag.sourceNames.join(', ')}` : label;
  }, [getSourceLabel]);

  const viewTasks = useCallback((tag: ReviewTag) => {
    const params = new URLSearchParams({ tag: tag.slug });
    if (scopeFilter.startsWith('list:')) {
      const sourceList = sourceLists.find(item => item.id === scopeFilter.slice(5));
      const connector = sourceList
        ? connectors.find(item => item.id === sourceList.connectorInstanceId)
        : undefined;
      if (sourceList) params.set('listId', `${sourceList.connectorInstanceId}:${sourceList.sourceId}`);
      if (connector) params.set('source', connector.type);
    } else if (scopeFilter !== 'all' && scopeFilter !== 'local') {
      params.set('source', scopeFilter);
    }
    router.push(`/?${params.toString()}`);
  }, [connectors, router, scopeFilter, sourceLists]);

  const exportCsv = useCallback(() => {
    const csvSafe = (value: string) => {
      const escaped = value.replace(/"/g, '""');
      return /^[=+\-@]/.test(escaped) ? `"\t${escaped}"` : `"${escaped}"`;
    };
    const tags = filteredTags.length > 0 ? filteredTags : userTags;
    const rows = [
      ['Name', 'Slug', 'Type', 'Source', 'Color', 'Usage Count', 'System Tag'].join(','),
      ...tags.map(tag => [
        csvSafe(tag.name),
        csvSafe(tag.slug),
        csvSafe(tag.type),
        csvSafe(getSourceLabel(tag)),
        csvSafe(tag.color || ''),
        tag.usageCount,
        'No',
      ].join(',')),
    ];
    const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `mission-control-tags-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${tags.length} tags`);
  }, [filteredTags, getSourceLabel, userTags]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-[var(--text-muted)] py-12">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">Loading tags...</span>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2 flex-shrink-0">Tags</h2>
      <p className="text-sm text-[var(--text-tertiary)] mb-4 flex-shrink-0">
        Filter by source, then select tags to merge, rename, recolor, remove, or view their tasks.
      </p>
      <motion.div variants={staggerContainer} initial="hidden" animate="show" className="flex-1 min-h-0 flex flex-col gap-4">
        <MergeSuggestions
          expanded={suggestionsExpanded}
          suggestions={mergeSuggestions}
          getSourceDetail={getSourceDetail}
          getSourceIcon={getSourceIcon}
          onExpandedChange={setSuggestionsExpanded}
          onReview={(a, b) => openMerge([a, b], 'suggestion')}
        />
        <motion.div variants={fadeSlideUp} className="flex-1 min-h-0 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl overflow-hidden">
          <div className="flex h-full min-h-0">
            <TagReviewFilters
              connectorTypeLabel={connectorTypeLabel}
              expandedSources={expandedScopeSources}
              listsByType={scopeOptions.listsByType}
              onExpandedSourcesChange={setExpandedScopeSources}
              onScopeChange={setScopeFilter}
              scopeFilter={scopeFilter}
              sources={scopeOptions.sources}
              systemTags={systemTags}
              userTags={userTags}
            />
            <TagReviewList
              aiTags={aiTags}
              busyTagId={mutations.busyTagId}
              confirmedAiTags={confirmedAiTags}
              filteredTags={filteredTags}
              getSourceDetail={getSourceDetail}
              getSourceIcon={getSourceIcon}
              getSourceLabel={getSourceLabel}
              mergeSuggestions={mergeSuggestions}
              mutationBusy={mutations.isBusy}
              onBulkDelete={() => {
                if (selectedTags.length === 1) {
                  dispatchDialog({ type: 'open-delete', tag: selectedTags[0] });
                } else {
                  dispatchDialog({ type: 'open-bulk-delete' });
                }
              }}
              onConfirmAi={tagId => void mutations.confirm(tagId)}
              onDelete={tag => dispatchDialog({ type: 'open-delete', tag })}
              onDismissAi={tag => void mutations.dismiss(tag)}
              onExport={exportCsv}
              onMerge={() => openMerge(selectedTags, 'selection')}
              onPush={tag => dispatchDialog({ type: 'open-push', tag })}
              onRecolor={tag => dispatchDialog({ type: 'open-recolor', tag })}
              onRename={tag => dispatchDialog({ type: 'open-rename', tag })}
              onReviewSuggestion={(a, b) => openMerge([a, b], 'suggestion')}
              onSearchChange={setSearchQuery}
              onSortChange={setSortBy}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              onViewTasks={viewTasks}
              pushableSourceLists={pushableSourceLists}
              scopeFilter={scopeFilter}
              searchQuery={searchQuery}
              selectedTagIds={selectedTagIds}
              selectedTags={selectedTags}
              sortBy={sortBy}
              sourceLists={sourceLists}
              sourceTagSlugs={sourceTagSlugs}
              systemTags={systemTags}
            />
          </div>
        </motion.div>
      </motion.div>

      <DeleteTagDialog
        busy={mutations.isBusy}
        dispatch={dispatchDialog}
        state={stateOfKind(dialog, 'delete')}
        onSubmit={(tag, writeBack) => {
          const expectedRevision = dialog.revision;
          void mutations.remove(tag, writeBack).finally(() =>
            dispatchDialog({ type: 'close', expectedRevision })
          );
        }}
      />
      <BulkDeleteTagsDialog
        busy={mutations.isBusy}
        dispatch={dispatchDialog}
        selectedTags={selectedTags}
        state={stateOfKind(dialog, 'bulk-delete')}
        onSubmit={(tags, writeBack) => {
          const expectedRevision = dialog.revision;
          void mutations.removeBulk(tags, writeBack).finally(() =>
            dispatchDialog({ type: 'close', expectedRevision })
          );
        }}
      />
      <MergeTagsDialog
        busy={mutations.isBusy}
        dispatch={dispatchDialog}
        getSourceDetail={getSourceDetail}
        mode={mergeMode}
        reviewTags={mergeReviewTags}
        state={mergeState}
        onSubmit={(tags, targetId, mode) => {
          const origin = mergeState?.origin;
          const expectedRevision = dialog.revision;
          void mutations.merge(tags, targetId, mode).then(success => {
            if (!success) return;
            if (origin === 'selection') setSelectedTagIds(new Set());
            dispatchDialog({ type: 'close', expectedRevision });
          });
        }}
      />
      <RenameTagDialog
        busy={mutations.isBusy}
        dispatch={dispatchDialog}
        state={stateOfKind(dialog, 'rename')}
        onSubmit={(tag, value) => {
          const expectedRevision = dialog.revision;
          void mutations.rename(tag, value).then(success => {
            if (success) dispatchDialog({ type: 'close', expectedRevision });
          });
        }}
      />
      <RecolorTagDialog
        busy={mutations.isBusy}
        dispatch={dispatchDialog}
        state={stateOfKind(dialog, 'recolor')}
        onSubmit={(tag, value) => {
          const expectedRevision = dialog.revision;
          void mutations.recolor(tag, value).then(success => {
            if (success) dispatchDialog({ type: 'close', expectedRevision });
          });
        }}
      />
      <PushTagDialog
        busy={mutations.isBusy}
        dispatch={dispatchDialog}
        sourceLists={pushableSourceLists}
        state={stateOfKind(dialog, 'push')}
        onSubmit={(tag, targetListId) => {
          const expectedRevision = dialog.revision;
          void mutations.push(tag, targetListId).then(success => {
            if (success) dispatchDialog({ type: 'close', expectedRevision });
          });
        }}
      />
    </div>
  );
}

export { TagReviewPanel };
