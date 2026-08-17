'use client';

import { AlertCircle, Brain, Calendar, CalendarClock, Clock, Flame, History, Plus, RotateCcw, Sparkles, Target } from 'lucide-react';
import { SuggestionGroup } from './SuggestionGroup';
import type { HubProject, TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import type { ListGroup } from '@/types/dashboard';
import type { SourceList, SuggestionGroups, SuggestionTask } from './types';

interface TodaySidebarProps {
  suggestions: SuggestionGroups;
  totalMinutes: number;
  whatsNextLoading: boolean;
  onAddToDay: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  getContextMenuActions: (task: SuggestionTask) => TaskContextMenuActions;
  sourceLists: SourceList[];
  listGroups: ListGroup[];
  projects: HubProject[];
  onGetWhatsNext: () => void;
}

export function TodaySidebar({
  suggestions,
  totalMinutes,
  whatsNextLoading,
  onAddToDay,
  onSelectTask,
  getContextMenuActions,
  sourceLists,
  listGroups,
  projects,
  onGetWhatsNext,
}: TodaySidebarProps) {
  const interactionProps = { onAdd: onAddToDay, onSelect: onSelectTask, getContextMenuActions, sourceLists, listGroups, projects };

  return (
    <aside className="flex h-full min-h-0 w-80 flex-shrink-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--surface-1)]" aria-label="Plan and focus suggestions">
      <div className="p-4 border-b border-[var(--border-subtle)]">
        <h3 className="font-semibold text-[var(--text-primary)] text-sm">Plan & Focus</h3>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <h4 className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase text-[var(--accent-400)]"><Target size={11} /> Do Next</h4>
          <p className="text-xs text-[var(--text-tertiary)] mb-2">Get AI-powered focus recommendation</p>
          <button onClick={onGetWhatsNext} disabled={whatsNextLoading} className="w-full rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-400)] disabled:opacity-50">
            {whatsNextLoading ? 'Thinking...' : 'Suggest Next Task'}
          </button>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 flex items-center gap-1"><Clock size={11} /> Quick Schedule</h4>
          <p className="text-xs text-[var(--text-muted)] mb-2">Drag or click tasks above, then assign a time block.</p>
          <div className="text-xs text-[var(--text-secondary)] bg-[var(--surface-0)] rounded p-2 border border-[var(--border)]">
            <p className="font-medium">{totalMinutes}min scheduled today</p>
            <p className="text-[var(--text-muted)]">{Math.max(0, 480 - totalMinutes)}min free (8h workday)</p>
          </div>
        </div>

        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2 flex items-center gap-1"><Sparkles size={11} /> Suggestions</h4>
          <SuggestionGroup title="Yesterday's Incomplete" icon={<History size={12} />} tasks={suggestions.yesterday} color="amber" {...interactionProps} />
          <SuggestionGroup title="Overdue" icon={<AlertCircle size={12} />} tasks={suggestions.overdue} color="red" sortable {...interactionProps} />
          <SuggestionGroup title="Due Today" icon={<CalendarClock size={12} />} tasks={suggestions.dueToday} color="blue" {...interactionProps} />
          <SuggestionGroup title="Due This Week" icon={<Calendar size={12} />} tasks={suggestions.dueThisWeek} color="cyan" sortable {...interactionProps} />
          <SuggestionGroup title="High Priority" icon={<Flame size={12} />} tasks={suggestions.highPriority} color="orange" {...interactionProps} />
          <SuggestionGroup title="AI Recommended" icon={<Brain size={12} />} tasks={suggestions.aiRecommended} color="purple" {...interactionProps} />
          <SuggestionGroup title="Recently Added" icon={<Plus size={12} />} tasks={suggestions.recentlyAdded} color="emerald" {...interactionProps} />
          <SuggestionGroup title="Carried Forward" icon={<RotateCcw size={12} />} tasks={suggestions.carriedForward} color="rose" {...interactionProps} />
          {Object.values(suggestions).every((group) => group.length === 0) && (
            <div className="border border-[var(--border)] rounded-md p-3 text-center">
              <p className="text-xs text-[var(--text-muted)]">You&apos;re all caught up   nice work! ??</p>
            </div>
          )}
        </div>

        <div className="p-3 bg-blue-900/30 rounded-lg border border-blue-800/30">
          <p className="text-xs text-blue-300">
            <strong>Tips:</strong> Click <Target size={9} className="inline" /> to enter focus mode. Click <Clock size={9} className="inline" /> to time-block a task. Use the Timeline view to see your day at a glance.
          </p>
        </div>
      </div>
    </aside>
  );
}
