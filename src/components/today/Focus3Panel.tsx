'use client';

import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Image from 'next/image';
import {
  Zap, X, Sparkles, Loader2, Square, FilePlus2, Search,
  BatteryMedium, Leaf, Moon, Check, ChevronDown, ChevronUp,
} from 'lucide-react';
import { toast } from 'sonner';
import { dropdownVariants, fadeSlideUp, scaleIn } from '@/lib/motion';
import { TaskPickerDialog } from '@/components/projects/TaskPickerDialog';
import { AddTaskModal } from '@/components/add-task';
import { getLocalToday } from '@/lib/utils/client-date';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import { Tooltip } from '@/components/ui/Tooltip';
import { uiLogger } from '@/lib/client-logger';
import { useViewMode } from '@/lib/hooks/useViewMode';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';
import type { TaskEditPolicy } from '@/types';
import { canEditTaskField, taskFieldBlockedReason } from '@/lib/tasks/client-edit-policy';

interface FocusItem {
  id: string;
  taskId: string;
  scope: string;
  date: string;
  slot: number;
  addedAt: string;
  isAiSuggested: boolean;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  editPolicy: TaskEditPolicy;
}

interface FocusSuggestion {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  score: number;
  energyDemand: 'high' | 'medium' | 'low' | null;
}

const CONNECTOR_ICONS: Record<string, string> = {
  'local': LOCAL_CONNECTOR_ICON_PATH,
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'document-intelligence': '/icons/agents/owl.svg',
};

const PRIORITY_DOT: Record<string, string> = {
  critical: 'bg-rose-500',
  high: 'bg-orange-400',
  medium: 'bg-amber-400',
  low: 'bg-sky-400',
  none: '',
};

function ConnectorIcon({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICONS[type];
  if (!src) return <Square size={size} className="text-[var(--text-muted)]" />;
  return <Image src={src} alt={type} width={size} height={size} className="shrink-0" />;
}

const MAX_SLOTS = 3;

const ENERGY_CONFIG: Record<string, { icon: typeof Zap; label: string; className: string }> = {
  high: { icon: Zap, label: 'High energy', className: 'text-amber-400' },
  medium: { icon: BatteryMedium, label: 'Medium energy', className: 'text-blue-400' },
  low: { icon: Leaf, label: 'Low energy', className: 'text-emerald-400' },
};

export function Focus3Panel({
  onRefresh,
  compact = false,
}: {
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const [scope, setScope] = useState<'today' | 'week'>('today');
  const [todayItems, setTodayItems] = useState<FocusItem[]>([]);
  const [weekItems, setWeekItems] = useState<FocusItem[]>([]);
  const [suggestions, setSuggestions] = useState<FocusSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const { completingIds, runTaskCompletion } = useTaskCompletion();

  const { toggleCalm } = useViewMode();

  const items = scope === 'today' ? todayItems : weekItems;

  const fetchFocusItems = useCallback(async () => {
    try {
      const res = await fetch(`/api/focus-items?date=${getLocalToday()}`);
      const data = await res.json();
      setTodayItems(data.today || []);
      setWeekItems(data.week || []);
    } catch (err) {
      uiLogger.error('Failed to fetch focus items', { err });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFocusItems(); }, [fetchFocusItems]);

  async function addFocusItem(taskId: string, isAiSuggested = false) {
    try {
      const res = await fetch('/api/focus-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, scope, isAiSuggested, date: getLocalToday() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to add focus item');
        return;
      }
      toast.success('Added to Focus 3');
      fetchFocusItems();
      setSuggestions(prev => prev.filter(s => s.id !== taskId));
      onRefresh?.();
    } catch {
      toast.error('Failed to add focus item');
    }
  }

  async function removeFocusItem(id: string) {
    try {
      await fetch(`/api/focus-items?id=${id}`, { method: 'DELETE' });
      fetchFocusItems();
      onRefresh?.();
    } catch {
      toast.error('Failed to remove focus item');
    }
  }

  async function completeFocusTask(taskId: string, title: string) {
    const task = todayItems.find((item) => item.taskId === taskId)
      ?? weekItems.find((item) => item.taskId === taskId);
    if (!task || !canEditTaskField(task.editPolicy, 'status')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'status'));
      return;
    }
    const previousTodayStatus = todayItems.find((item) => item.taskId === taskId)?.status;
    const previousWeekStatus = weekItems.find((item) => item.taskId === taskId)?.status;
    const markStatus = (items: FocusItem[], status: string) => items.map((item) => (
      item.taskId === taskId ? { ...item, status } : item
    ));
    const restoreStatus = (items: FocusItem[], status: string) => items.map((item) => (
      item.taskId === taskId && item.status === 'done' ? { ...item, status } : item
    ));

    const outcome = await runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        setTodayItems((current) => markStatus(current, 'done'));
        setWeekItems((current) => markStatus(current, 'done'));
      },
      request: async () => {
        const response = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        });
        if (!response.ok) throw new Error('Failed to complete task');
      },
      rollback: () => {
        if (previousTodayStatus !== undefined) {
          setTodayItems((current) => restoreStatus(current, previousTodayStatus));
        }
        if (previousWeekStatus !== undefined) {
          setWeekItems((current) => restoreStatus(current, previousWeekStatus));
        }
      },
    });

    if (outcome === 'completed') {
      toast.success(`"${title}" completed`);
      window.dispatchEvent(new CustomEvent('mc:task-completed'));
      fetchFocusItems();
      onRefresh?.();
    } else if (outcome === 'failed') {
      toast.error('Failed to complete task');
    }
  }

  async function suggestFocus() {
    setSuggesting(true);
    setShowSuggestions(true);
    try {
      const res = await fetch('/api/ai/suggest-focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();
      setSuggestions(data.suggestions || []);
    } catch {
      toast.error('Failed to get suggestions');
    } finally {
      setSuggesting(false);
    }
  }

  // Build slot array (always 3 slots, some may be empty)
  const slots = Array.from({ length: MAX_SLOTS }, (_, i) => {
    const slotNum = i + 1;
    return items.find(item => item.slot === slotNum) || null;
  });

  const emptySlots = slots.filter(s => s === null).length;

  return (
    <section className="bg-[var(--surface-1)] rounded-lg border border-[var(--border)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-amber-400" />
          <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--text-tertiary)] font-semibold">
            Focus 3
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {/* Calm mode launch */}
          {items.length > 0 && (
            <Tooltip content="Focus in Calm Mode">
              <button
                onClick={() => toggleCalm({
                  type: 'focus3',
                  taskIds: items.map(item => item.taskId),
                  label: 'Focus 3',
                })}
                className="p-1.5 text-[var(--text-muted)] hover:text-slate-300 hover:bg-[var(--surface-2)] rounded transition-colors"
              >
                <Moon size={13} />
              </button>
            </Tooltip>
          )}
          {/* Scope toggle */}
          <div className="flex bg-[var(--surface-2)] rounded-md p-0.5">
            <button
              onClick={() => setScope('today')}
              className={`px-2.5 py-1 text-xs rounded transition-[background-color,color,box-shadow] duration-150 ${
                scope === 'today'
                  ? 'bg-[var(--surface-1)] shadow-sm font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setScope('week')}
              className={`px-2.5 py-1 text-xs rounded transition-[background-color,color,box-shadow] duration-150 ${
                scope === 'week'
                  ? 'bg-[var(--surface-1)] shadow-sm font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
              }`}
            >
              This Week
            </button>
          </div>
          <Tooltip content={collapsed ? 'Expand Focus 3' : 'Collapse Focus 3'}>
            <button
              type="button"
              onClick={() => setCollapsed((current) => !current)}
              aria-expanded={!collapsed}
              className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] rounded transition-colors"
            >
              {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            </button>
          </Tooltip>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
      {/* Slots */}
      <div className={`px-4 ${compact ? 'py-2' : 'py-3'}`}>
        {loading ? (
          <div className="flex items-center justify-center py-4 text-[var(--text-muted)]">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : (
          <div className="space-y-1.5">
            <AnimatePresence mode="popLayout">
              {slots.map((item, i) => (
                <motion.div
                  key={item ? item.id : `empty-${i}`}
                  variants={fadeSlideUp}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  layout
                >
                  {item ? (
                    <FocusSlot
                      item={item}
                      slotNumber={i + 1}
                      onRemove={() => removeFocusItem(item.id)}
                      onComplete={() => completeFocusTask(item.taskId, item.title)}
                      isCompleting={completingIds.has(item.taskId)}
                    />
                  ) : (
                    <EmptySlot slotNumber={i + 1} onClick={() => setAddMenuOpen(!addMenuOpen)} />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* AI Suggest / Drop zone */}
      {emptySlots > 0 && (
        <div className="px-4 pb-3">
          <button
            onClick={suggestFocus}
            disabled={suggesting}
            className="w-full px-3 py-2 text-xs rounded-md border border-dashed border-[var(--border-strong)] text-[var(--text-tertiary)] hover:border-blue-500/50 hover:text-blue-400 hover:bg-blue-900/10 transition-[border-color,color,background-color] duration-150 flex items-center justify-center gap-1.5 font-medium"
          >
            {suggesting ? (
              <>
                <Loader2 size={11} className="animate-spin" />
                Finding focus…
              </>
            ) : (
              <>
                <Sparkles size={11} />
                AI Suggest
              </>
            )}
          </button>
        </div>
      )}

      {/* AI Suggestions dropdown */}
      <AnimatePresence>
        {showSuggestions && suggestions.length > 0 && (
          <motion.div
            variants={scaleIn}
            initial="hidden"
            animate="show"
            exit="exit"
            className="border-t border-[var(--border-subtle)] bg-[var(--surface-0)]"
          >
            <div className="px-4 py-2 flex items-center justify-between">
              <span className="text-xs text-purple-400 font-semibold flex items-center gap-1">
                <Sparkles size={10} /> AI Suggestions
              </span>
              <button
                onClick={() => setShowSuggestions(false)}
                className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              >
                <X size={12} />
              </button>
            </div>
            <div className="px-4 pb-3 space-y-1">
              {suggestions.map(s => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-white/5 transition-colors group/sug"
                >
                  <ConnectorIcon type={s.connectorType} size={12} />
                  {PRIORITY_DOT[s.priority] && (
                    <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[s.priority]}`} />
                  )}
                  <span className="text-xs text-[var(--text-primary)] truncate flex-1">
                    {s.title}
                  </span>
                  {s.energyDemand && ENERGY_CONFIG[s.energyDemand] && (() => {
                    const cfg = ENERGY_CONFIG[s.energyDemand!];
                    return (
                      <span className={`inline-flex items-center gap-0.5 text-xs ${cfg.className} opacity-70 flex-shrink-0`} title={cfg.label}>
                        <cfg.icon size={9} />
                      </span>
                    );
                  })()}
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={() => addFocusItem(s.id, true)}
                    disabled={emptySlots <= 0}
                    className="text-xs px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-1)] text-blue-400 hover:bg-blue-900/30 hover:border-blue-500/50 transition-[background-color,border-color] duration-150 opacity-0 group-hover/sug:opacity-100 disabled:opacity-30"
                  >
                    + Focus
                  </motion.button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Add Task Menu (same pattern as PhaseAddTaskMenu) */}
      {emptySlots > 0 && (
        <div className="px-4 pb-3 relative">
          <AnimatePresence>
            {addMenuOpen && (
              <FocusAddTaskMenu
                onCreateNew={() => {
                  setAddMenuOpen(false);
                  setShowCreateTask(true);
                }}
                onLinkExisting={() => {
                  setAddMenuOpen(false);
                  setShowPicker(true);
                }}
                onClose={() => setAddMenuOpen(false)}
              />
            )}
          </AnimatePresence>
        </div>
      )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Task Picker Dialog */}
      {showPicker && (
        <TaskPickerDialog
          excludeTaskIds={items.map(item => item.taskId)}
          onClose={() => setShowPicker(false)}
          onConfirm={(taskIds) => {
            taskIds.forEach(id => addFocusItem(id));
            setShowPicker(false);
          }}
          title="Pick a task to focus on"
        />
      )}

      {/* Create New Task Modal */}
      <AnimatePresence>
        {showCreateTask && (
          <AddTaskModal
            initialInput=""
            initialParsed={null}
            initialDestination={{ id: 'local', label: 'Local', connectorType: 'local', account: null, color: 'var(--text-muted)' }}
            destinations={[{ id: 'local', label: 'Local', connectorType: 'local', account: null, color: 'var(--text-muted)' }]}
            onTaskCreated={(taskId) => {
              void addFocusItem(taskId);
            }}
            onClose={() => setShowCreateTask(false)}
            onSubmit={() => setShowCreateTask(false)}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function FocusSlot({
  item,
  slotNumber,
  onRemove,
  onComplete,
  isCompleting,
}: {
  item: FocusItem;
  slotNumber: number;
  onRemove: () => void;
  onComplete: () => void;
  isCompleting: boolean;
}) {
  const isCompleted = item.status === 'done';
  const visuallyCompleted = isCompleted || isCompleting;
  const canComplete = canEditTaskField(item.editPolicy, 'status');

  function handleComplete() {
    if (visuallyCompleted || !canComplete) return;
    onComplete();
  }

  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-[var(--surface-0)] transition-[background-color] duration-100">
      {/* Completion checkbox with burst */}
      <CompletionBurst celebrating={isCompleting}>
        <button
          onClick={handleComplete}
          disabled={visuallyCompleted || !canComplete}
          className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0 border transition-[background-color,border-color,color] duration-150 ${
            visuallyCompleted
              ? 'bg-emerald-900/40 text-emerald-400 border-emerald-800/30'
              : 'bg-blue-900/40 text-blue-400 border-blue-800/30 hover:bg-emerald-900/30 hover:border-emerald-700/40 hover:text-emerald-400'
          }`}
          title={visuallyCompleted
            ? 'Completed'
            : canComplete
              ? 'Mark complete'
              : taskFieldBlockedReason(item.editPolicy, 'status')}
        >
          {visuallyCompleted ? <Check size={14} /> : slotNumber}
        </button>
      </CompletionBurst>

      {/* Connector icon */}
      <ConnectorIcon type={item.connectorType} size={14} />

      {/* Task info */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${
          visuallyCompleted
            ? 'line-through text-[var(--text-muted)]'
            : 'text-[var(--text-primary)]'
        }`}>
          {item.title}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          {item.sourceListName && (
            <span className="text-xs text-[var(--text-muted)]">{item.sourceListName}</span>
          )}
          {item.isAiSuggested && (
            <span className="text-xs text-purple-400/70 flex items-center gap-0.5">
              <Sparkles size={8} /> AI
            </span>
          )}
        </div>
      </div>

      {/* Priority dot */}
      {PRIORITY_DOT[item.priority] && (
        <span className={`w-2 h-2 rounded-full ${PRIORITY_DOT[item.priority]} flex-shrink-0`} />
      )}

      {/* Remove button */}
      <Tooltip content="Remove from Focus 3">
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-[opacity,color] duration-150 flex-shrink-0"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

function EmptySlot({ slotNumber, onClick }: { slotNumber: number; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md border border-dashed border-[var(--border)] opacity-40 hover:opacity-70 hover:border-blue-500/50 hover:bg-blue-900/5 transition-[opacity,border-color,background-color] duration-150 cursor-pointer text-left"
    >
      <span className="w-6 h-6 bg-[var(--surface-2)] text-[var(--text-muted)] rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0">
        {slotNumber}
      </span>
      <span className="text-xs text-[var(--text-muted)]">
        Open slot — pick a task or let AI suggest one
      </span>
    </button>
  );
}

function FocusAddTaskMenu({
  onCreateNew,
  onLinkExisting,
  onClose,
}: {
  onCreateNew: () => void;
  onLinkExisting: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-focus-add-menu]')) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <motion.div
      data-focus-add-menu
      className="absolute left-4 bottom-full z-30 mb-1.5 w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_8px_24px_rgba(0,0,0,0.3)]"
      variants={dropdownVariants}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <button
        type="button"
        onClick={onCreateNew}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
      >
        <FilePlus2 size={14} className="text-[var(--accent)]" />
        Create new task
      </button>
      <button
        type="button"
        onClick={onLinkExisting}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
      >
        <Search size={14} className="text-[var(--text-secondary)]" />
        Pick existing task
      </button>
    </motion.div>
  );
}
