'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, Clock, Grid3x3, Inbox, List, Loader2, Maximize2, RefreshCw, Sparkles, X } from 'lucide-react';
import { useListAnimate } from '@/lib/hooks/useListAnimate';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { BulkActionBar, executeBulkOperation, useBulkSelection } from '@/components/bulk-actions';
import { AddTaskModal, type TaskPrefill } from '@/components/add-task';
import AutoTriageModal from '@/components/triage/AutoTriageModal';
import CaptureForm from '@/components/triage/CaptureForm';
import DecisionPanel from '@/components/triage/DecisionPanel';
import FocusView from '@/components/triage/FocusView';
import TriageAIInsights from '@/components/triage/TriageAIInsights';
import TriageFilterSidebar from '@/components/triage/TriageFilterSidebar';
import TriageGalleryView, { type GalleryDensity } from '@/components/triage/TriageGalleryView';
import TriageQuickStats from '@/components/triage/TriageQuickStats';
import TriageStreamItem from '@/components/triage/TriageStreamItem';
import TriageSyncStatus from '@/components/triage/TriageSyncStatus';
import { MobileTriageView } from '@/components/triage/mobile';
import { ACTION_META, SORT_OPTIONS, type TriageSortOption, type ViewMode } from '@/components/triage/types';
import { NAVIGATION_COUNTS_REFRESH_EVENT } from '@/lib/navigation/badges';
import { useTriageData } from '@/lib/hooks/useTriageData';
import { cn } from '@/lib/utils/cn';
import { buildActionTitle } from '@/lib/triage/actions/build-task-title';
import { toast } from 'sonner';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';
import type {
  TriageActionRecord,
  TriageActionType,
  TriageItem,
  TriageSourcePlatform,
  TriageStatus,
} from '@/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// ─── Bulk Set Type Dropdown ─────────────────────────────────────────────────

function BulkSetTypeDropdown({ onSelect }: { onSelect: (contentType: string) => void }) {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<Array<{ id: string; name: string; color: string }>>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/triage/content-types')
      .then((r) => r.json())
      .then((data) => {
        if (data.contentTypes) setTypes(data.contentTypes.filter((ct: { suppressed: boolean }) => !ct.suppressed));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((p) => !p)}
        className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-amber-800/40 bg-amber-900/30 px-2 py-1 text-xs text-amber-300 transition-colors duration-100 hover:bg-amber-900/50"
      >
        Set type <ChevronDown size={10} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-[12px] border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-lg">
          {types.map((ct) => (
            <button
              key={ct.id}
              type="button"
              onClick={() => { setOpen(false); onSelect(ct.id); }}
              className="flex w-full items-center gap-2 rounded-[8px] px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)]"
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ct.color }} />
              {ct.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const readStored = <T extends string>(key: string, values: readonly T[], fallback: T) => typeof window === 'undefined' ? fallback : values.includes(localStorage.getItem(key) as T) ? (localStorage.getItem(key) as T) : fallback;
const readStoredFlag = (key: string, fallback: boolean) => typeof window === 'undefined' ? fallback : localStorage.getItem(key) !== 'false';

export default function TriagePage() {
  const [status, setStatus] = useState<TriageStatus | 'all'>('pending');
  const [source, setSource] = useState<TriageSourcePlatform | 'all'>('all');
  const [query, setQuery] = useState('');
  const [captureUrl, setCaptureUrl] = useState('');
  const [captureSource, setCaptureSource] = useState<TriageSourcePlatform>('web');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768 && !localStorage.getItem('mc-triage-view-mode')) return 'focus';
    return readStored('mc-triage-view-mode', ['stream', 'gallery', 'focus'] as const, 'stream');
  });
  const [galleryDensity, setGalleryDensity] = useState<GalleryDensity>(() => readStored('mc-triage-gallery-density', ['spacious', 'default', 'compact'] as const, 'default'));
  const [sortBy, setSortBy] = useState<TriageSortOption>(() => readStored('mc-triage-sort-by', ['relevance', 'newest', 'oldest', 'score'] as const, 'relevance'));
  const [contentTypeFilter, setContentTypeFilter] = useState<string | null>(null);
  const [actionTypeFilter, setActionTypeFilter] = useState<TriageActionType | null>(null);
  const [embedsEnabled, setEmbedsEnabled] = useState(() => readStoredFlag('mc-triage-embeds-enabled', true));
  const [showAutoTriage, setShowAutoTriage] = useState(false);
  const inFlightActionItemsRef = useRef(new Set<string>());
  const queuedActionItemsRef = useRef(new Set<string>());
  const actionMutationQueueRef = useRef(Promise.resolve());
  const bulk = useBulkSelection();
  const [triageListRef] = useListAnimate();
  const { items, stats, selectedId, setSelectedId, selectedItem, loading, loadingMore, hasMore, totalFiltered, loadItems, loadMore } = useTriageData({ status, source, query, sortBy });

  // Pull-to-refresh for mobile
  const onTriageRefresh = useCallback(async () => { await loadItems(); }, [loadItems]);
  const { containerRef: triagePullRef, isRefreshing: triageRefreshing, pullDistance: triagePullDistance, containerProps: triagePullProps, contentStyle: triagePullContentStyle } = usePullToRefresh({ onRefresh: onTriageRefresh });

  const filteredItems = useMemo(() => {
    let result = items;
    if (contentTypeFilter) result = result.filter((item) => item.contentType === contentTypeFilter);
    if (actionTypeFilter) result = result.filter((item) => item.actionsTaken.some((a) => a.actionType === actionTypeFilter));
    return result;
  }, [items, contentTypeFilter, actionTypeFilter]);

  const contentTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      counts[item.contentType] = (counts[item.contentType] || 0) + 1;
    }
    return counts;
  }, [items]);

  const actionTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      for (const action of item.actionsTaken) {
        counts[action.actionType] = (counts[action.actionType] || 0) + 1;
      }
    }
    return counts;
  }, [items]);

  const setStoredViewMode = useCallback((next: ViewMode) => { setViewMode(next); localStorage.setItem('mc-triage-view-mode', next); bulk.clearSelection(); }, [bulk]);
  const toggleViewMode = useCallback(() => { setStoredViewMode(viewMode === 'stream' ? 'gallery' : viewMode === 'gallery' ? 'focus' : 'stream'); }, [setStoredViewMode, viewMode]);
  const updateDensity = useCallback((next: GalleryDensity) => { setGalleryDensity(next); localStorage.setItem('mc-triage-gallery-density', next); }, []);
  const updateSortBy = useCallback((next: TriageSortOption) => { setSortBy(next); localStorage.setItem('mc-triage-sort-by', next); }, []);

  const acquireItemMutation = useCallback(async (itemId: string): Promise<(() => void) | null> => {
    if (queuedActionItemsRef.current.has(itemId)) return null;
    queuedActionItemsRef.current.add(itemId);
    const previousMutation = actionMutationQueueRef.current;
    let releaseQueue = () => {};
    actionMutationQueueRef.current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousMutation;
    inFlightActionItemsRef.current.add(itemId);
    return () => {
      inFlightActionItemsRef.current.delete(itemId);
      queuedActionItemsRef.current.delete(itemId);
      releaseQueue();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldBlockGlobalShortcut(event)) return;
      const target = event.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if ((event.key === 'g' || event.key === 'G') && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        toggleViewMode();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleViewMode]);

  const handleItemAction = useCallback(async (
    itemId: string,
    actionType: TriageActionType,
    options?: { showSuccessToast?: boolean },
  ): Promise<TriageActionRecord | null> => {
    const finishMutation = await acquireItemMutation(itemId);
    if (!finishMutation) return null;

    try {
      // For open_document, open the document URL in a new tab
      if (actionType === 'open_document') {
        const target = items.find((i) => i.id === itemId);
        const docUrl = target?.rawMetadata?.documentUrl as string | undefined
          || target?.sourceUrl;
        if (docUrl) {
          window.open(docUrl, '_blank', 'noopener,noreferrer');
        }
      }

      setSelectedId(itemId);
      setBusyAction(actionType);
      let appliedAction: TriageActionRecord | null = null;
      try {
        const res = await fetch(`/api/triage/${itemId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType }) });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
          toast.error(data.error || `Action failed (${res.status})`);
        } else {
          const data = await res.json() as { item?: TriageItem };
          appliedAction = data.item?.actionsTaken.at(-1) ?? null;
          const label = ACTION_META[actionType]?.label || actionType.replace(/_/g, ' ');
          if (options?.showSuccessToast !== false) {
            toast.success(`${label} applied`);
          }
          window.dispatchEvent(new Event(NAVIGATION_COUNTS_REFRESH_EVENT));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error — action failed');
      }
      await loadItems();
      return appliedAction;
    } finally {
      finishMutation();
      setBusyAction(null);
    }
  }, [acquireItemMutation, loadItems, setSelectedId, items]);

  const handleUndoItemAction = useCallback(async (
    itemId: string,
    action: TriageActionRecord,
  ): Promise<boolean> => {
    if (!action.id) {
      toast.error('This action can no longer be undone');
      return false;
    }
    const finishMutation = await acquireItemMutation(itemId);
    if (!finishMutation) return false;
    setBusyAction('undo');
    try {
      const res = await fetch(`/api/triage/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          undo: true,
          actionType: action.actionType,
          actionId: action.id,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `Undo failed (${res.status})` }));
        toast.error(data.error || `Undo failed (${res.status})`);
        return false;
      }
      await loadItems();
      window.dispatchEvent(new Event(NAVIGATION_COUNTS_REFRESH_EVENT));
      toast.success('Action undone');
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Network error — undo failed');
      return false;
    } finally {
      finishMutation();
      setBusyAction(null);
    }
  }, [acquireItemMutation, loadItems]);

  const handleDeleteItem = useCallback(async (itemId: string) => {
    setBusyAction('delete');
    await fetch(`/api/triage/${itemId}`, { method: 'DELETE' });
    setBusyAction(null);
    setSelectedId(null);
    await loadItems();
  }, [loadItems, setSelectedId]);

  const handleBatchAction = useCallback(async (itemIds: string[], actionType: TriageActionType) => {
    const promises = itemIds.map((id) =>
      fetch(`/api/triage/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType }) })
    );
    await Promise.all(promises);
    toast.success(`Applied "${ACTION_META[actionType].label}" to ${itemIds.length} item${itemIds.length !== 1 ? 's' : ''}`);
    await loadItems();
  }, [loadItems]);

  const handleAutoTriageExecute = useCallback(async (plan: Array<{ actionType: TriageActionType; itemIds: string[] }>) => {
    let totalProcessed = 0;
    for (const group of plan) {
      const promises = group.itemIds.map((id) =>
        fetch(`/api/triage/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType: group.actionType }) })
      );
      await Promise.all(promises);
      totalProcessed += group.itemIds.length;
    }
    toast.success(`Auto-triaged ${totalProcessed} item${totalProcessed !== 1 ? 's' : ''}`);
    await loadItems();
  }, [loadItems]);

  async function submitCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!captureUrl.trim()) return;
    setBusyAction('capture');
    await fetch('/api/triage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: captureUrl.trim(), sourcePlatform: captureSource }) });
    setCaptureUrl('');
    setBusyAction(null);
    await loadItems();
  }

  // --- Task modal state ---
  const [taskModalItem, setTaskModalItem] = useState<TriageItem | null>(null);
  const [taskPrefill, setTaskPrefill] = useState<TaskPrefill | undefined>(undefined);
  const [taskDestinations, setTaskDestinations] = useState<Array<{ id: string; label: string; connectorType: string; account: 'personal' | 'work' | null; color: string }>>([
    { id: 'local', label: 'Local', connectorType: 'local', account: null, color: 'var(--text-muted)' },
  ]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/features')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.taskDestinations?.length) {
          const dests = data.taskDestinations.map((td: { id: string; type: string; name: string; account?: string }) => ({
            id: td.id,
            label: td.name,
            connectorType: td.type,
            account: (td.account as 'personal' | 'work') || null,
            color: td.type === 'microsoft-todo' ? '#5b5fc7' : td.type === 'github-issues' ? '#8b949e' : 'var(--text-muted)',
          }));
          dests.push({ id: 'local', label: 'Local', connectorType: 'local', account: null, color: 'var(--text-muted)' });
          setTaskDestinations(dests);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function buildTaskPrefill(item: TriageItem): TaskPrefill {
    const lines: string[] = [];
    if (/^https?:\/\//i.test(item.sourceUrl)) lines.push(`Source: ${item.sourceUrl}`);
    if (item.aiSummary) lines.push('', item.aiSummary);
    if (item.description && item.description !== item.aiSummary) lines.push('', item.description);
    lines.push('', `Captured from ${item.sourcePlatform} on ${new Date(item.capturedAt).toLocaleDateString()}`);
    const prefill: TaskPrefill = {
      title: buildActionTitle(item),
      description: lines.join('\n'),
      tags: [
        `triage:${item.sourcePlatform}`,
        ...(Array.isArray(item.rawMetadata?.suggestedTags)
          ? item.rawMetadata.suggestedTags.filter((tag): tag is string => typeof tag === 'string')
          : []),
      ],
    };
    if (item.sourcePlatform === 'scout') {
      const priority = item.rawMetadata?.priority;
      if (priority === 'critical' || priority === 'high' || priority === 'medium' || priority === 'low' || priority === 'none') {
        prefill.priority = priority;
      }
      if (typeof item.rawMetadata?.dueDate === 'string') {
        prefill.dueDate = item.rawMetadata.dueDate;
      }
      if (typeof item.rawMetadata?.effectiveProjectId === 'string') {
        prefill.projectId = item.rawMetadata.effectiveProjectId;
      }
    }
    return prefill;
  }

  const handleCreateTask = useCallback((item: TriageItem, _preferredAction?: TriageActionType) => {
    setTaskPrefill(buildTaskPrefill(item));
    setTaskModalItem(item);
  }, []);

  const handleTaskCreated = useCallback(async () => {
    setTaskModalItem(null);
    setTaskPrefill(undefined);
    await loadItems();
  }, [loadItems]);

  const isMobile = useIsMobile();

  // ─── Mobile redesign: full takeover on small screens ────────────────────────
  if (isMobile) {
    return (
      <MobileTriageView
        items={filteredItems}
        loading={loading}
        onAction={handleItemAction}
        onUndoAction={handleUndoItemAction}
        busyAction={busyAction}
        onRefresh={onTriageRefresh}
        stats={{ processedToday: stats.actioned + stats.dismissed, streak: 0, totalProcessed: stats.actioned + stats.dismissed }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--background)]">
      {/* Full-height 3-column layout (sidebar hidden on mobile) */}
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 gap-4 px-4 py-4 sm:px-6">
        <div className="hidden md:flex w-[300px] shrink-0 overflow-y-auto xl:w-[340px] flex-col">
          <div className="flex-1">
            <TriageFilterSidebar
              stats={stats}
              query={query}
              onQueryChange={setQuery}
              onRefresh={() => void loadItems()}
              status={status}
              onStatusChange={setStatus}
              source={source}
              onSourceChange={setSource}
              contentTypeFilter={contentTypeFilter}
              onContentTypeChange={setContentTypeFilter}
              contentTypeCounts={contentTypeCounts}
              actionTypeFilter={actionTypeFilter}
              onActionTypeChange={setActionTypeFilter}
              actionTypeCounts={actionTypeCounts}
            />
          </div>
          <TriageSyncStatus />
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--surface-1)]">
          {/* Inline capture bar */}
          <div className="border-b border-[var(--border)] px-4 py-2.5">
            <CaptureForm captureUrl={captureUrl} setCaptureUrl={setCaptureUrl} captureSource={captureSource} setCaptureSource={setCaptureSource} busyAction={busyAction} onSubmit={submitCapture} />
          </div>

          {/* Queue header */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Queue</h3>
            <span className="text-xs tabular-nums text-[var(--text-tertiary)]">{stats.pending} pending</span>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              {/* Sort dropdown */}
              <Select
                value={sortBy}
                onValueChange={(value) => updateSortBy(value as TriageSortOption)}
              >
                <SelectTrigger variant="inline" aria-label="Sort triage queue">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
                </SelectContent>
              </Select>

              {/* Auto-Triage button */}
              <button
                type="button"
                onClick={() => setShowAutoTriage(true)}
                className="inline-flex items-center gap-1.5 rounded-[8px] bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-600)]"
              >
                <Sparkles size={12} />
                Auto-Triage
              </button>

              {/* Gallery density (only in gallery mode) */}
              {viewMode === 'gallery' && (
                <div className="inline-flex overflow-hidden rounded-[8px] border border-[var(--border)]">
                  {(['spacious', 'default', 'compact'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => updateDensity(d)}
                      className={cn(
                        'px-2 py-1 text-xs font-medium transition-colors',
                        galleryDensity === d
                          ? 'bg-[var(--accent-900)] text-[var(--accent-400)]'
                          : 'bg-[var(--surface-0)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                      )}
                    >
                      {d === 'spacious' ? '3col' : d === 'default' ? '4col' : '5col'}
                    </button>
                  ))}
                </div>
              )}

              {/* Bulk select toggle (stream mode only) */}
              {filteredItems.length > 0 && viewMode === 'stream' ? (
                <button
                  onClick={bulk.bulkMode ? () => bulk.clearSelection() : bulk.enterBulkMode}
                  className={cn(
                    'rounded-[8px] border px-2 py-1 text-xs font-medium transition-colors',
                    bulk.bulkMode
                      ? 'border-[var(--accent)]/30 bg-[var(--accent-900)]/30 text-[var(--accent-400)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                  )}
                >
                  {bulk.bulkMode ? `${bulk.bulkSelected.size} selected` : 'Select'}
                </button>
              ) : null}

              {/* View mode switcher */}
              <div className="inline-flex shrink-0 overflow-hidden rounded-[8px] border border-[var(--surface-3)]">
                <button type="button" onClick={() => setStoredViewMode('stream')} className={cn('flex items-center gap-1 border-r border-[var(--surface-3)] px-3 py-1.5 text-[12px] font-medium transition-[background-color,color] duration-100', viewMode === 'stream' ? 'bg-[var(--accent-900)] text-[var(--accent-400)]' : 'bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]')}><List size={11} />Stream</button>
                <button type="button" onClick={() => setStoredViewMode('gallery')} className={cn('flex items-center gap-1 border-r border-[var(--surface-3)] px-3 py-1.5 text-[12px] font-medium transition-[background-color,color] duration-100', viewMode === 'gallery' ? 'bg-[var(--accent-900)] text-[var(--accent-400)]' : 'bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]')}><Grid3x3 size={11} />Gallery</button>
                <button type="button" onClick={() => setStoredViewMode('focus')} className={cn('flex items-center gap-1 px-3 py-1.5 text-[12px] font-medium transition-[background-color,color] duration-100', viewMode === 'focus' ? 'bg-[var(--accent-900)] text-[var(--accent-400)]' : 'bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]')}><Maximize2 size={11} />Focus<kbd className="ml-1 rounded-[3px] border border-[var(--accent)]/30 bg-transparent px-1 py-0 font-mono text-[12px] font-semibold text-[var(--accent-400)]">G</kbd></button>
              </div>
            </div>
          </div>

          {bulk.bulkMode && viewMode === 'stream' ? (
            <BulkActionBar selectedCount={bulk.bulkSelected.size} onCancel={bulk.clearSelection}>
              <button
                onClick={async () => {
                  const ids = Array.from(bulk.bulkSelected);
                  const { failed } = await executeBulkOperation(ids, (id) => fetch(`/api/triage/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType: 'dismiss' }) }), `Dismissed ${ids.length} item${ids.length > 1 ? 's' : ''}`);
                  if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                  else bulk.clearSelection();
                  await loadItems();
                }}
                className="rounded-[var(--radius-sm)] border border-slate-800/40 bg-slate-900/30 px-2 py-1 text-xs text-slate-300 transition-colors duration-100 hover:bg-slate-900/50"
              >
                <X size={12} className="inline" /> Dismiss
              </button>
              <button
                onClick={async () => {
                  const ids = Array.from(bulk.bulkSelected);
                  const { failed } = await executeBulkOperation(ids, (id) => fetch(`/api/triage/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType: 'snooze' }) }), `Snoozed ${ids.length} item${ids.length > 1 ? 's' : ''}`);
                  if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                  else bulk.clearSelection();
                  await loadItems();
                }}
                className="rounded-[var(--radius-sm)] border border-sky-800/40 bg-sky-900/30 px-2 py-1 text-xs text-sky-300 transition-colors duration-100 hover:bg-sky-900/50"
              >
                <Clock size={12} className="inline" /> Snooze
              </button>
              <button
                onClick={async () => {
                  const ids = Array.from(bulk.bulkSelected);
                  setBusyAction('reclassify');
                  try {
                    const res = await fetch('/api/triage/reclassify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'auto', ids }) });
                    const data = await res.json();
                    if (res.ok) {
                      toast.success(`Reclassified ${data.changed} of ${data.total} items`);
                    } else {
                      toast.error(data.error || 'Reclassify failed');
                    }
                  } catch { toast.error('Network error'); }
                  setBusyAction(null);
                  bulk.clearSelection();
                  await loadItems();
                }}
                className="rounded-[var(--radius-sm)] border border-purple-800/40 bg-purple-900/30 px-2 py-1 text-xs text-purple-300 transition-colors duration-100 hover:bg-purple-900/50"
              >
                <RefreshCw size={12} className="inline" /> Auto-classify
              </button>
              <BulkSetTypeDropdown
                onSelect={async (contentType) => {
                  const ids = Array.from(bulk.bulkSelected);
                  setBusyAction('set_type');
                  try {
                    const res = await fetch('/api/triage/reclassify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set_type', ids, contentType }) });
                    const data = await res.json();
                    if (res.ok) {
                      toast.success(data.message);
                    } else {
                      toast.error(data.error || 'Set type failed');
                    }
                  } catch { toast.error('Network error'); }
                  setBusyAction(null);
                  bulk.clearSelection();
                  await loadItems();
                }}
              />
            </BulkActionBar>
          ) : null}

          {/* Scrollable queue content */}
          <div className="relative flex-1 overflow-auto p-3" ref={triagePullRef} {...triagePullProps}>
            {/* Pull-to-refresh indicator — absolutely positioned */}
            {triagePullDistance > 0 && (
              <div className="absolute left-0 right-0 top-0 z-50 flex items-center justify-center pointer-events-none sm:hidden" style={{ height: `${triagePullDistance}px` }}>
                <RefreshCw size={16} className={cn('text-[var(--text-muted)] transition-transform', triageRefreshing && 'animate-spin', triagePullDistance > 60 && 'text-[var(--accent-400)]')} />
              </div>
            )}
            <div style={triagePullContentStyle}>
            {viewMode === 'gallery' ? (
              <TriageGalleryView items={filteredItems} selectedId={selectedId} onSelect={setSelectedId} onAction={(id, actionType) => void handleItemAction(id, actionType)} busyAction={busyAction} loading={loading} density={galleryDensity} onDensityChange={updateDensity} />
            ) : viewMode === 'focus' ? (
              <FocusView items={filteredItems} selectedId={selectedId} onSelect={setSelectedId} onAction={(id, actionType) => void handleItemAction(id, actionType)} busyAction={busyAction} loading={loading} embedsEnabled={embedsEnabled} />
            ) : loading ? (
              <div className="flex min-h-[240px] items-center justify-center text-[var(--text-tertiary)]"><Loader2 className="animate-spin" size={18} /></div>
            ) : filteredItems.length === 0 ? (
              <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center"><Inbox size={24} className="text-[var(--text-tertiary)]" /><div className="text-sm font-medium text-[var(--text-primary)]">No triage items match these filters.</div><div className="text-xs text-[var(--text-tertiary)]">Clear filters or capture a new URL above.</div></div>
            ) : (
              <div ref={triageListRef} className="space-y-3">
                {filteredItems.map((item) => (
                  <TriageStreamItem key={item.id} item={item} isSelected={selectedItem?.id === item.id} isBulkSelected={bulk.bulkSelected.has(item.id)} bulkMode={bulk.bulkMode} onSelect={() => setSelectedId(item.id)} onBulkToggle={() => bulk.toggleItem(item.id)} onAction={(id, actionType) => void handleItemAction(id, actionType)} embedsEnabled={embedsEnabled} />
                ))}
                {hasMore ? (
                  <div className="flex items-center justify-center py-4">
                    <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="flex items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent-400)] disabled:opacity-50">
                      {loadingMore ? <Loader2 size={12} className="animate-spin" /> : null}
                      {loadingMore ? 'Loading…' : `Load more (${filteredItems.length} of ${totalFiltered})`}
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          </div>
        </div>

        <div className="hidden lg:block w-[420px] min-w-[340px] shrink-0 overflow-y-auto space-y-3">
          <TriageQuickStats stats={stats} items={items} />
          <TriageAIInsights items={items} onBatchAction={(ids, actionType) => void handleBatchAction(ids, actionType)} />
          <DecisionPanel selectedItem={selectedItem} onAction={(itemId, actionType) => void handleItemAction(itemId, actionType)} onCreateTask={handleCreateTask} onDelete={(itemId) => void handleDeleteItem(itemId)} onItemUpdated={() => void loadItems()} busyAction={busyAction} embedsEnabled={embedsEnabled} />
        </div>
      </div>

      <AutoTriageModal
        open={showAutoTriage}
        onClose={() => setShowAutoTriage(false)}
        items={items}
        onExecute={handleAutoTriageExecute}
      />

      {taskModalItem && (
        <AddTaskModal
          initialInput=""
          initialParsed={null}
          initialDestination={taskDestinations[0]}
          destinations={taskDestinations}
          onClose={() => { setTaskModalItem(null); setTaskPrefill(undefined); }}
          onSubmit={() => { setTaskModalItem(null); setTaskPrefill(undefined); }}
          onTaskCreated={() => void handleTaskCreated()}
          prefill={taskPrefill}
          triageItemId={taskModalItem.id}
        />
      )}
    </div>
  );
}
