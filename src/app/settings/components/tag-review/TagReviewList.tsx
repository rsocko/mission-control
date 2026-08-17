'use client';

import { motion } from 'motion/react';
import {
  CheckCircle2,
  CircleHelp,
  Download,
  ExternalLink,
  Eye,
  Link2,
  Loader2,
  Merge,
  Palette,
  Pencil,
  Search,
  Trash2,
  XCircle,
  Zap,
  Lock,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/Tooltip';
import { getTagPillStyle } from '@/lib/constants/colors';
import { fadeSlideUp, staggerContainer } from '@/lib/motion';
import { ConnectorBrandIcon } from '../ConnectorBrandIcon';
import { getScopedUsageCount, getSystemCategory } from './heuristics';
import type { ReviewTag, SourceListInfo, TagSort } from './types';

interface TagReviewListProps {
  aiTags: ReviewTag[];
  busyTagId: string | null;
  confirmedAiTags: ReviewTag[];
  filteredTags: ReviewTag[];
  getSourceDetail: (tag: ReviewTag) => string;
  getSourceIcon: (tag: ReviewTag) => string | null;
  getSourceLabel: (tag: ReviewTag) => string;
  mergeSuggestions: Array<{ a: ReviewTag; b: ReviewTag }>;
  mutationBusy: boolean;
  onBulkDelete: () => void;
  onConfirmAi: (tagId: string) => void;
  onDelete: (tag: ReviewTag) => void;
  onDismissAi: (tag: ReviewTag) => void;
  onExport: () => void;
  onMerge: () => void;
  onPush: (tag: ReviewTag) => void;
  onRecolor: (tag: ReviewTag) => void;
  onRename: (tag: ReviewTag) => void;
  onReviewSuggestion: (a: ReviewTag, b: ReviewTag) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: TagSort) => void;
  onToggleSelect: (tagId: string) => void;
  onToggleSelectAll: () => void;
  onViewTasks: (tag: ReviewTag) => void;
  pushableSourceLists: SourceListInfo[];
  scopeFilter: string;
  searchQuery: string;
  selectedTagIds: Set<string>;
  selectedTags: ReviewTag[];
  sortBy: TagSort;
  sourceLists: SourceListInfo[];
  sourceTagSlugs: Set<string>;
  systemTags: ReviewTag[];
}

export function TagReviewList(props: TagReviewListProps) {
  const {
    aiTags,
    busyTagId,
    confirmedAiTags,
    filteredTags,
    getSourceDetail,
    getSourceIcon,
    getSourceLabel,
    mergeSuggestions,
    mutationBusy,
    onBulkDelete,
    onConfirmAi,
    onDelete,
    onDismissAi,
    onExport,
    onMerge,
    onPush,
    onRecolor,
    onRename,
    onReviewSuggestion,
    onSearchChange,
    onSortChange,
    onToggleSelect,
    onToggleSelectAll,
    onViewTasks,
    pushableSourceLists,
    scopeFilter,
    searchQuery,
    selectedTagIds,
    selectedTags,
    sortBy,
    sourceLists,
    sourceTagSlugs,
    systemTags,
  } = props;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-0)]/50">
        <div className="flex-1 relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={event => onSearchChange(event.target.value)}
            placeholder="Filter tags..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--surface-1)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
        </div>
        <Select value={sortBy} onValueChange={value => onSortChange(value as TagSort)}>
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
          onClick={onExport}
          className="inline-flex items-center gap-1 px-2 py-1.5 text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] transition-colors"
          title="Export tags as CSV"
        >
          <Download size={11} /> CSV
        </button>
      </div>

      <div className="flex items-center gap-3 px-4 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border)]">
        <div className="w-5 flex items-center justify-center">
          <input
            type="checkbox"
            checked={filteredTags.length > 0 && selectedTagIds.size === filteredTags.length}
            onChange={onToggleSelectAll}
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

      <div role="region" aria-label="Tag list" tabIndex={0} className="flex-1 min-h-0 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500/50">
        {filteredTags.length === 0 && (
          <div className="flex items-center justify-center py-12 text-sm text-[var(--text-muted)]">
            {searchQuery ? 'No tags match your search' : 'No tags found'}
          </div>
        )}
        <motion.div variants={staggerContainer} initial="hidden" animate="show">
          {filteredTags.map(tag => {
            const selected = selectedTagIds.has(tag.id);
            const mcOnly = tag.type === 'hub' && !sourceTagSlugs.has(tag.slug);
            const suggestion = mergeSuggestions.find(item =>
              item.a.id === tag.id || item.b.id === tag.id
            );
            const scopedUsageCount = getScopedUsageCount(tag, scopeFilter, sourceLists);
            const showsScopedCount = scopeFilter !== 'all' && scopeFilter !== 'local';
            const sourceIcon = getSourceIcon(tag);

            return (
              <motion.div
                key={tag.id}
                variants={fadeSlideUp}
                className={`flex items-center gap-3 px-4 py-2 transition-colors group cursor-pointer ${
                  selected ? 'bg-blue-500/10' : 'hover:bg-[var(--surface-2)]/50'
                }`}
                onClick={() => onToggleSelect(tag.id)}
              >
                <div className="w-5 flex items-center justify-center" onClick={event => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleSelect(tag.id)}
                    aria-label={`Select ${tag.name}`}
                    className="rounded border-[var(--border)] w-3.5 h-3.5 accent-blue-500"
                  />
                </div>
                <div className="flex-1 flex items-center gap-2 min-w-0">
                  <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full border border-[var(--border)]" style={getTagPillStyle(tag.color)}>
                    {tag.name}
                  </span>
                  {mcOnly && (
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
                        onReviewSuggestion(tag, counterpart);
                      }}
                      className="text-[9px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-400 border border-amber-800/30 inline-flex items-center gap-0.5 hover:bg-amber-900/50 hover:text-amber-300 transition-colors"
                      aria-label={`Merge with ${suggestion.a.id === tag.id ? suggestion.b.name : suggestion.a.name}`}
                      title={`Start merge workflow with ${suggestion.a.id === tag.id ? getSourceDetail(suggestion.b) : getSourceDetail(suggestion.a)}`}
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
                  {sourceIcon ? (
                    <span className="inline-flex max-w-full items-center gap-1 text-[10px] text-[var(--text-muted)]" title={getSourceDetail(tag)}>
                      <ConnectorBrandIcon type={sourceIcon} size={12} />
                      <span className="truncate">{getSourceLabel(tag)}</span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-[var(--text-muted)]">{getSourceLabel(tag)}</span>
                  )}
                </div>
                <div className="w-12 flex justify-center">
                  {tag.color && (
                    <button
                      type="button"
                      className="h-4 w-4 cursor-pointer rounded-full border border-[var(--border)] transition-transform hover:scale-110"
                      style={{ background: tag.color }}
                      onClick={event => {
                        event.stopPropagation();
                        onRecolor(tag);
                      }}
                      title="Change color"
                      aria-label={`Recolor ${tag.name}`}
                    />
                  )}
                </div>
                <div className="w-24 flex justify-end" onClick={event => event.stopPropagation()}>
                  <div className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {tag.usageCount > 0 && (
                      <button type="button" onClick={() => onViewTasks(tag)} className="p-1 rounded text-[var(--text-muted)] hover:text-blue-400 hover:bg-[var(--surface-2)]" title="View tasks" aria-label={`View tasks tagged ${tag.name}`}>
                        <Eye size={11} />
                      </button>
                    )}
                    <button type="button" onClick={() => onRename(tag)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]" title="Rename" aria-label={`Rename ${tag.name}`}>
                      <Pencil size={11} />
                    </button>
                    {mcOnly && pushableSourceLists.length > 0 && (
                      <button type="button" onClick={() => onPush(tag)} className="p-1 rounded text-[var(--text-muted)] hover:text-blue-400 hover:bg-[var(--surface-2)]" title="Push to source" aria-label={`Push ${tag.name} to source`}>
                        <ExternalLink size={11} />
                      </button>
                    )}
                    <button type="button" onClick={() => onDelete(tag)} className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--surface-2)]" title="Remove" aria-label={`Remove ${tag.name}`}>
                      {busyTagId === tag.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>

        {systemTags.length > 0 && scopeFilter === 'all' && !searchQuery && (
          <div className="border-t border-[var(--border)] mt-2 pt-2 px-4 pb-2 opacity-60">
            <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5 flex items-center gap-1">
              <Lock size={9} /> System-managed (read-only)
            </p>
            {systemTags.map(tag => (
              <div key={tag.id} className="flex items-center gap-3 py-1.5">
                <div className="w-5" />
                <div className="flex-1 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-[var(--border)]" style={getTagPillStyle(tag.color)}>
                    <Lock size={8} className="opacity-50" /> {tag.name}
                  </span>
                  <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-muted)] uppercase tracking-wide">
                    {getSystemCategory(tag.name) || 'system'}
                  </span>
                </div>
                <div className="w-28 text-right text-xs text-[var(--text-muted)] tabular-nums">{tag.usageCount}</div>
                <div className="w-32" />
                <div className="w-12" />
                <div className="w-24" />
              </div>
            ))}
          </div>
        )}
        {aiTags.length > 0 && (
          <div className="border-t border-[var(--border)] p-4">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
              <span className="w-2 h-2 bg-amber-500 rounded-full" />
              AI-Inferred Tags ({aiTags.length})
              <span className="text-xs font-normal text-[var(--text-muted)]">— suggested by AI, confirm to keep</span>
            </h3>
            <div className="flex flex-wrap gap-2">
              {aiTags.map(tag => (
                <span key={tag.id} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-dashed border-amber-800/30 bg-amber-900/20 text-amber-300">
                  <Zap size={9} /> {tag.name}
                  <span className="text-xs opacity-60 tabular-nums">({tag.usageCount})</span>
                  <button type="button" disabled={mutationBusy} onClick={() => onConfirmAi(tag.id)} className="ml-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-40" title="Confirm">
                    {busyTagId === tag.id ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                  </button>
                  <button type="button" disabled={mutationBusy} onClick={() => onDismissAi(tag)} className="text-red-400 hover:text-red-300 disabled:opacity-40" title="Dismiss">
                    {busyTagId === tag.id ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={11} />}
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        {confirmedAiTags.length > 0 && (
          <div className="border-t border-[var(--border)] p-4">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
              <span className="w-2 h-2 bg-emerald-500 rounded-full" />
              Confirmed AI Tags ({confirmedAiTags.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {confirmedAiTags.map(tag => (
                <span key={tag.id} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-[var(--border)]" style={getTagPillStyle(tag.color)}>
                  <CheckCircle2 size={9} className="text-emerald-400" />
                  {tag.name}
                  <span className="text-xs text-[var(--text-muted)] tabular-nums">({tag.usageCount})</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {selectedTags.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-t border-[var(--border)] bg-[var(--surface-0)]/80">
          <span className="text-xs text-[var(--text-muted)]">{selectedTags.length} selected</span>
          <div className="flex items-center gap-1.5 ml-2">
            <button type="button" onClick={onMerge} disabled={selectedTags.length < 2} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <Merge size={11} /> Review Merge
            </button>
            <button type="button" onClick={onBulkDelete} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded-md hover:bg-red-500/20 transition-colors">
              <Trash2 size={11} /> Remove{selectedTags.length > 1 ? ` (${selectedTags.length})` : ''}
            </button>
            <button type="button" onClick={() => {
              if (selectedTags.length === 1) onRename(selectedTags[0]);
            }} disabled={selectedTags.length !== 1} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] bg-[var(--surface-1)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <Pencil size={11} /> Rename
            </button>
            <button type="button" onClick={() => {
              if (selectedTags.length === 1) onRecolor(selectedTags[0]);
            }} disabled={selectedTags.length !== 1} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] bg-[var(--surface-1)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <Palette size={11} /> Recolor
            </button>
            {selectedTags.length === 1 && selectedTags[0].usageCount > 0 && (
              <button type="button" onClick={() => onViewTasks(selectedTags[0])} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] bg-[var(--surface-1)] border border-[var(--border)] rounded-md hover:bg-[var(--surface-2)] transition-colors">
                <Eye size={11} /> View Tasks
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
