'use client';

import { AlertTriangle, Plus, X, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import type { KanbanColumn } from './types';

interface ColumnHeaderProps {
  column: KanbanColumn;
  colIdx: number;
  totalColumns: number;
  taskCount: number;
  editingColumns: boolean;
  isProjectView: boolean;
  globalColumns: KanbanColumn[];
  renamingColumn: string | null;
  renameValue: string;
  quickAddColumn: string | null;
  wipLimit?: number;
  onStartRename: (colId: string, currentName: string) => void;
  onRenameChange: (val: string) => void;
  onConfirmRename: (colId: string) => void;
  onCancelRename: () => void;
  onReorder: (colId: string, direction: 'left' | 'right') => void;
  onRemove: (colId: string) => void;
  onToggleQuickAdd: (colId: string) => void;
  onWipLimitChange?: (colId: string, limit: number | undefined) => void;
}

export function ColumnHeader({
  column,
  colIdx,
  totalColumns,
  taskCount,
  editingColumns,
  isProjectView,
  globalColumns,
  renamingColumn,
  renameValue,
  quickAddColumn,
  wipLimit,
  onStartRename,
  onRenameChange,
  onConfirmRename,
  onCancelRename,
  onReorder,
  onRemove,
  onToggleQuickAdd,
  onWipLimitChange,
}: ColumnHeaderProps) {
  const isUnmapped = isProjectView && (!column.globalColumnMapping || !globalColumns.find(gc => gc.id === column.globalColumnMapping));
  const isOverWip = wipLimit !== undefined && wipLimit > 0 && taskCount > wipLimit;

  return (
    <div className="flex items-center gap-2 mb-1">
      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: column.color }} />

      {/* Editable name in edit mode */}
      {editingColumns && renamingColumn === column.id ? (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={renameValue}
            onChange={e => onRenameChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onConfirmRename(column.id);
              if (e.key === 'Escape') onCancelRename();
            }}
            className="text-sm font-semibold px-1 py-0 bg-[var(--surface-0)] border border-blue-500/50 rounded text-[var(--text-primary)] w-24 focus:outline-none"
          />
          <button onClick={() => onConfirmRename(column.id)} className="p-0.5 text-green-400 hover:text-green-300"><Check size={12} /></button>
          <button onClick={onCancelRename} className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"><X size={12} /></button>
        </div>
      ) : (
        <h3
          className={`text-sm font-semibold text-[var(--text-secondary)] ${editingColumns ? 'cursor-pointer hover:text-blue-400' : ''}`}
          onClick={() => { if (editingColumns) onStartRename(column.id, column.name); }}
          title={editingColumns ? 'Click to rename' : undefined}
        >
          {column.name}
        </h3>
      )}

      <span className={`text-xs px-1.5 py-0.5 rounded ${
        isOverWip
          ? 'bg-red-500/20 text-red-400 font-semibold'
          : 'text-[var(--text-muted)] bg-[var(--surface-2)]'
      }`}>
        {taskCount}{wipLimit && wipLimit > 0 ? `/${wipLimit}` : ''}
      </span>

      {/* WIP limit exceeded warning */}
      {isOverWip && (
        <span className="text-red-400 flex items-center gap-0.5" title={`WIP limit exceeded (${taskCount}/${wipLimit})`}>
          <AlertTriangle size={11} />
        </span>
      )}

      {/* Unmapped warning badge */}
      {isUnmapped && (
        <Tooltip content="Not mapped to a global column" subtitle="Tasks won't appear correctly in All Projects view">
          <span className="text-amber-400 flex items-center gap-0.5">
            <AlertTriangle size={11} />
          </span>
        </Tooltip>
      )}

      {/* Quick-add button (normal mode) */}
      {!editingColumns && (
        <Tooltip content="Quick add task to this column">
          <button
            onClick={() => onToggleQuickAdd(column.id)}
            className={`ml-auto p-0.5 rounded hover:bg-blue-900/20 text-[var(--text-muted)] hover:text-blue-400 transition-colors ${quickAddColumn === column.id ? 'text-blue-400' : ''}`}
          >
            <Plus size={13} />
          </button>
        </Tooltip>
      )}

      {/* Reorder + delete + WIP limit (edit mode) */}
      {editingColumns && (
        <div className="ml-auto flex items-center gap-0.5">
          {onWipLimitChange && (
            <Tooltip content="WIP limit (0 = no limit)">
              <input
                type="number"
                min="0"
                placeholder="WIP"
                value={wipLimit || ''}
                onChange={e => {
                  const val = e.target.value ? parseInt(e.target.value, 10) : undefined;
                  onWipLimitChange(column.id, val && val > 0 ? val : undefined);
                }}
                className="w-10 text-[12px] text-center px-0.5 py-0.5 bg-[var(--surface-0)] border border-[var(--border)] rounded text-[var(--text-muted)] focus:outline-none focus:shadow-none"
              />
            </Tooltip>
          )}
          <Tooltip content="Move left">
            <button
              onClick={() => onReorder(column.id, 'left')}
              disabled={colIdx === 0}
              className="p-0.5 rounded hover:bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] disabled:opacity-25 transition-colors"
            >
              <ArrowLeft size={12} />
            </button>
          </Tooltip>
          <Tooltip content="Move right">
            <button
              onClick={() => onReorder(column.id, 'right')}
              disabled={colIdx === totalColumns - 1}
              className="p-0.5 rounded hover:bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] disabled:opacity-25 transition-colors"
            >
              <ArrowRight size={12} />
            </button>
          </Tooltip>
          {totalColumns > 1 && (
            <Tooltip content="Remove column">
              <button
                onClick={() => onRemove(column.id)}
                className="p-0.5 rounded hover:bg-red-900/20 text-[var(--text-muted)] hover:text-red-400 transition-colors"
              >
                <X size={12} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
