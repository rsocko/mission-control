'use client';

import { Plus, Pencil, Search, ArrowUpDown } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';

export type SwimlaneMode = 'none' | 'project' | 'priority';

interface BoardControlsProps {
  isProjectView: boolean;
  projectName?: string;
  hasCustomColumns: boolean;
  editingColumns: boolean;
  showSources: boolean;
  showDueDates: boolean;
  newColumnName: string;
  searchQuery: string;
  swimlaneMode: SwimlaneMode;
  scoreSortEnabled: boolean;
  onToggleEdit: () => void;
  onResetColumns: () => void;
  onShowSourcesChange: (val: boolean) => void;
  onShowDueDatesChange: (val: boolean) => void;
  onNewColumnNameChange: (val: string) => void;
  onAddColumn: () => void;
  onSearchChange: (val: string) => void;
  onSwimlaneChange: (val: SwimlaneMode) => void;
  onScoreSortChange: (val: boolean) => void;
}

export function BoardControls({
  isProjectView,
  projectName,
  hasCustomColumns,
  editingColumns,
  showSources,
  showDueDates,
  newColumnName,
  searchQuery,
  swimlaneMode,
  scoreSortEnabled,
  onToggleEdit,
  onResetColumns,
  onShowSourcesChange,
  onShowDueDatesChange,
  onNewColumnNameChange,
  onAddColumn,
  onSearchChange,
  onSwimlaneChange,
  onScoreSortChange,
}: BoardControlsProps) {
  const columnLabel = isProjectView
    ? `Project (${projectName})`
    : hasCustomColumns ? 'Custom (Global)' : 'Default (Status)';

  return (
    <div className="flex items-center justify-between mb-4 px-1 py-2 border-b border-[var(--border-subtle)]">
      <div className="flex items-center gap-3">
        <span className="text-xs text-[var(--text-muted)]">Columns:</span>
        <span className="text-xs bg-[var(--surface-2)] text-[var(--text-secondary)] px-2 py-0.5 rounded">
          {columnLabel}
        </span>
        <button
          onClick={onToggleEdit}
          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
        >
          <Pencil size={10} /> {editingColumns ? 'Done' : 'Edit'}
        </button>
        {editingColumns && (hasCustomColumns || isProjectView) && (
          <button
            onClick={onResetColumns}
            className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1"
          >
            Reset to Default
          </button>
        )}
      </div>
      <div className="flex items-center gap-4">
        {/* Board search */}
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search board…"
            className="text-xs pl-6 pr-2 py-1 bg-[var(--surface-0)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] w-36 focus:outline-none transition-[width] duration-150 focus:w-48"
          />
        </div>

        {/* Score sort toggle */}
        <button
          onClick={() => onScoreSortChange(!scoreSortEnabled)}
          className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border transition-colors ${
            scoreSortEnabled
              ? 'border-blue-500/40 bg-blue-900/20 text-blue-400'
              : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
          title={scoreSortEnabled ? 'Sorting by Smart Score — click to use default order' : 'Click to sort by Smart Score'}
        >
          <ArrowUpDown size={11} />
          Score Sort
        </button>

        {/* Swimlane selector */}
        <Select value={swimlaneMode} onValueChange={(v) => onSwimlaneChange(v as SwimlaneMode)}>
          <Tooltip content="Swimlane grouping">
            <SelectTrigger className="text-xs border border-[var(--border)] rounded-md px-2 py-1 text-[var(--text-secondary)] bg-transparent w-auto">
              <SelectValue />
            </SelectTrigger>
          </Tooltip>
          <SelectContent>
            <SelectItem value="none">No swimlanes</SelectItem>
            <SelectItem value="priority">By Priority</SelectItem>
            <SelectItem value="project">By Project</SelectItem>
          </SelectContent>
        </Select>

        <label className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showSources}
            onChange={e => onShowSourcesChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-[var(--border-strong)] text-blue-600 cursor-pointer"
          />
          Show sources
        </label>
        <label className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showDueDates}
            onChange={e => onShowDueDatesChange(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-[var(--border-strong)] text-blue-600 cursor-pointer"
          />
          Show due dates
        </label>
        {editingColumns && (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={newColumnName}
              onChange={e => onNewColumnNameChange(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && onAddColumn()}
              placeholder="Column name"
              className="text-xs px-2 py-1 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)] w-28 outline-none"
            />
            <button
              onClick={onAddColumn}
              disabled={!newColumnName.trim()}
              className="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-0.5 disabled:opacity-40"
            >
              <Plus size={11} /> Add Column
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
