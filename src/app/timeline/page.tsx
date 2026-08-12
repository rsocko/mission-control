'use client';

import type { ComponentType } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckSquare, ChevronLeft, ChevronRight, FileText, GitBranch, Mail, MessageSquare, Pin, MailOpen } from 'lucide-react';
import { getLocalToday } from '@/lib/utils/client-date';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { uiLogger } from '@/lib/client-logger';
import { fetchAllTasks } from '@/lib/tasks/fetch-all';
import { LocalSourceIcon } from '@/components/ui/LocalSourceIcon';

interface CalendarTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
}

const CONNECTOR_ICONS: Record<string, { icon: ComponentType<{ size?: number; className?: string }>; label: string }> = {
  'local': { icon: LocalSourceIcon, label: 'Local' },
  'microsoft-todo': { icon: CheckSquare, label: 'Todo' },
  'github-issues': { icon: GitBranch, label: 'GitHub' },
  'outlook-email': { icon: Mail, label: 'Email' },
  'outlook-calendar': { icon: CalendarDays, label: 'Calendar' },
  'rymessage': { icon: MessageSquare, label: 'RyMessage' },
  'document-intelligence': { icon: FileText, label: 'Docs' },
};

const PRIORITY_DOT: Record<string, string> = {
  critical: 'bg-rose-500',
  high: 'bg-orange-400',
  medium: 'bg-amber-400',
  low: 'bg-sky-400',
  none: 'bg-gray-300',
};

export default function TimelinePage() {
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const fetchTasks = useCallback(async () => {
    try {
      setTasks(await fetchAllTasks<CalendarTask>('/api/tasks?parentOnly=true'));
    } catch (err) {
      uiLogger.error('Failed to fetch tasks for timeline', { err });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTasks();
  }, [fetchTasks]);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  // Calendar grid
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = getLocalToday();

  const calendarDays: Array<{ day: number; date: string; tasks: CalendarTask[] }> = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayTasks = tasks.filter(t => t.dueDate === date);
    calendarDays.push({ day: d, date, tasks: dayTasks });
  }

  function prevMonth() {
    setCurrentMonth(new Date(year, month - 1, 1));
  }
  function nextMonth() {
    setCurrentMonth(new Date(year, month + 1, 1));
  }

  const monthLabel = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Tasks without due dates
  const undated = tasks.filter(t => !t.dueDate && t.status !== 'done');

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <CalendarDays size={20} /> Timeline
            </h2>
            <div className="flex items-center gap-2">
              <button onClick={prevMonth} className="px-2 py-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded"><ChevronLeft size={16} /></button>
              <span className="text-sm font-medium text-[var(--text-secondary)] min-w-[140px] text-center">{monthLabel}</span>
              <button onClick={nextMonth} className="px-2 py-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded"><ChevronRight size={16} /></button>
              <button onClick={() => setCurrentMonth(new Date())}
                className="ml-2 px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
                Today
              </button>
            </div>
          </div>

          {loading ? (
            <div className="text-center text-[var(--text-muted)] py-8 animate-pulse">Loading...</div>
          ) : (
            <>
              {/* Calendar Grid */}
              <div className="bg-[var(--surface-1)] rounded-lg border border-[var(--border)] overflow-hidden">
                {/* Day headers */}
                <div className="grid grid-cols-7 border-b border-[var(--border)]">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                    <div key={day} className="px-2 py-2 text-center text-xs font-semibold text-[var(--text-tertiary)] bg-[var(--surface-0)]">
                      {day}
                    </div>
                  ))}
                </div>

                {/* Calendar cells */}
                <div className="grid grid-cols-7">
                  {/* Empty cells for offset */}
                  {Array.from({ length: firstDay }).map((_, i) => (
                    <div key={`empty-${i}`} className="min-h-[90px] border-b border-r border-[var(--border-subtle)] bg-[var(--surface-0)]/50" />
                  ))}

                  {calendarDays.map(({ day, date, tasks: dayTasks }) => {
                    const isToday = date === today;
                    const isPast = date < today;
                    const hasOverdue = isPast && dayTasks.some(t => !isInactiveTaskStatus(t.status));

                    return (
                      <div key={date}
                        className={`min-h-[90px] border-b border-r border-[var(--border-subtle)] p-1.5 ${
                          isToday ? 'bg-blue-900/30/50 ring-1 ring-inset ring-blue-200' : ''
                        }`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className={`text-xs font-medium ${
                            isToday ? 'text-blue-400 bg-blue-100 w-5 h-5 rounded-full flex items-center justify-center' :
                            isPast ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'
                          }`}>
                            {day}
                          </span>
                          {hasOverdue && <span className="w-1.5 h-1.5 rounded-full bg-red-900/300" title="Has tasks to revisit" />}
                        </div>
                        <div className="space-y-0.5">
                          {dayTasks.slice(0, 3).map(task => (
                            <div key={task.id}
                              className={`flex items-center gap-1 px-1 py-0.5 rounded text-xs truncate ${
                                task.status === 'done'
                                  ? 'opacity-50 line-through text-[var(--text-muted)]'
                                  : task.status === 'cancelled'
                                    ? 'opacity-50 text-[var(--text-muted)]'
                                    : 'text-[var(--text-secondary)]'
                              }`}
                              title={task.title}>
                              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority] || PRIORITY_DOT.none}`} />
                              <span className="truncate">{task.title}</span>
                            </div>
                          ))}
                          {dayTasks.length > 3 && (
                            <span className="text-xs text-[var(--text-muted)] px-1">+{dayTasks.length - 3} more</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Summary stats */}
              <div className="mt-4 flex gap-4 text-xs text-[var(--text-tertiary)]">
                <span className="flex items-center gap-1"><Pin size={10} /> {tasks.filter(t => t.dueDate && t.status !== 'done').length} with due dates</span>
                <span className="flex items-center gap-1"><MailOpen size={10} /> {undated.length} undated</span>
                <span className="flex items-center gap-1"><AlertTriangle size={10} /> {tasks.filter(t => t.dueDate && t.dueDate < today && t.status !== 'done').length} past due</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right sidebar: Upcoming */}
      <aside className="w-72 bg-[var(--surface-1)] border-l border-[var(--border)] p-4 overflow-y-auto flex-shrink-0">
        <h3 className="font-semibold text-[var(--text-primary)] text-sm mb-3">Upcoming</h3>
        <div className="space-y-2">
          {tasks
            .filter(t => t.dueDate && t.dueDate >= today && t.status !== 'done')
            .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
            .slice(0, 10)
            .map(task => (
              <div key={task.id} className="flex items-center gap-2 p-2 rounded border border-[var(--border-subtle)] hover:bg-[var(--surface-0)]">
                <span className={`w-2 h-2 rounded-full ${PRIORITY_DOT[task.priority]}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--text-primary)] truncate">{task.title}</p>
                  <p className="text-xs text-[var(--text-muted)] flex items-center gap-1">{task.dueDate} · {(() => { const c = CONNECTOR_ICONS[task.connectorType]; return c ? <c.icon size={10} /> : <Pin size={10} />; })()}</p>
                </div>
              </div>
            ))}
        </div>

        {undated.length > 0 && (
          <>
            <h3 className="font-semibold text-[var(--text-primary)] text-sm mt-6 mb-3">Undated ({undated.length})</h3>
            <div className="space-y-1">
              {undated.slice(0, 8).map(task => (
                <div key={task.id} className="text-xs text-[var(--text-tertiary)] truncate px-2 py-1 flex items-center gap-1">
                  {(() => { const c = CONNECTOR_ICONS[task.connectorType]; return c ? <c.icon size={10} /> : null; })()} {task.title}
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}