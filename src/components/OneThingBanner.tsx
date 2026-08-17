'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Image from 'next/image';
import {
  Target, Sparkles, Loader2, X, ChevronDown, ChevronRight, Check, CheckCircle2,
  ArrowRight, Shuffle, Trophy,
} from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip } from '@/components/ui/Tooltip';
import { fadeSlideUp, scaleIn, oneThingCelebration, oneThingConfetti, oneThingGlow } from '@/lib/motion';
import { uiLogger } from '@/lib/client-logger';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';
import { getTaskPriorityVisual } from '@/lib/constants/task-formatting';

interface OneThingTask {
  id: string;
  taskId: string;
  weekMonday: string;
  isManualOverride: boolean;
  completedAt: string | null;
  createdAt: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  justCompleted?: boolean;
  subtaskTotal?: number;
  subtaskDone?: number;
}

interface SearchTask {
  id: string;
  title: string;
  priority: string;
  connectorType: string;
  dueDate: string | null;
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

const CONFETTI_EMOJIS = ['🎉', '⭐', '🔥', '✨', '💪', '🏆'];

function ConnectorIcon({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICONS[type];
  if (!src) return null;
  return <Image src={src} alt={type} width={size} height={size} className="shrink-0" />;
}

export function OneThingBanner({
  onTaskClick,
  onRefresh,
  embedded,
  collapsed,
  onToggleCollapse,
}: {
  onTaskClick?: (taskId: string) => void;
  onRefresh?: () => void;
  embedded?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [oneThing, setOneThing] = useState<OneThingTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<string>('none');
  const [showSwapPicker, setShowSwapPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchTask[]>([]);
  const [searching, setSearching] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const celebrationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasTriggeredCelebration = useRef(false);

  // Clean up celebration timeout on unmount
  useEffect(() => {
    return () => {
      if (celebrationTimeoutRef.current) clearTimeout(celebrationTimeoutRef.current);
    };
  }, []);

  const fetchOneThing = useCallback(async () => {
    try {
      const res = await fetch('/api/one-thing');
      const data = await res.json();
      setOneThing(data.oneThing || null);
      setSource(data.source || 'none');

      // Trigger celebration if just completed
      if (data.oneThing?.justCompleted && !hasTriggeredCelebration.current) {
        hasTriggeredCelebration.current = true;
        setCelebrating(true);
        toast.success('🏆 You did it! Your ONE THING is done!', {
          duration: 5000,
        });
        if (celebrationTimeoutRef.current) clearTimeout(celebrationTimeoutRef.current);
        celebrationTimeoutRef.current = setTimeout(() => setCelebrating(false), 2000);
      }
    } catch (err) {
      uiLogger.error('Failed to fetch one thing', { err });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOneThing(); }, [fetchOneThing]);

  // Check for completion periodically (picks up status changes from task list)
  useEffect(() => {
    if (!oneThing || oneThing.completedAt) return;
    const interval = setInterval(fetchOneThing, 15000);
    return () => clearInterval(interval);
  }, [oneThing, fetchOneThing]);

  async function searchTasks(query: string) {
    setSearching(true);
    try {
      const params = new URLSearchParams({ openOnly: 'true', parentOnly: 'true', limit: '30' });
      const res = await fetch(`/api/tasks?${params}`);
      const data = await res.json();
      let results: SearchTask[] = (data.tasks || []).map((t: SearchTask) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        connectorType: t.connectorType,
        dueDate: t.dueDate,
      }));
      // Client-side title filtering (API doesn't support search param)
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        results = results.filter((t: SearchTask) => t.title.toLowerCase().includes(q));
      }
      setSearchResults(results.slice(0, 10));
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => searchTasks(value), 300);
  }

  async function swapOneThing(taskId: string) {
    try {
      const res = await fetch('/api/one-thing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || 'Failed to swap');
        return;
      }
      toast.success('Swapped your ONE THING');
      setShowSwapPicker(false);
      setSearchQuery('');
      setSearchResults([]);
      hasTriggeredCelebration.current = false;
      fetchOneThing();
      onRefresh?.();
    } catch {
      toast.error('Failed to swap one thing');
    }
  }

  async function clearOneThing() {
    try {
      await fetch('/api/one-thing', { method: 'DELETE' });
      hasTriggeredCelebration.current = false;
      fetchOneThing();
      onRefresh?.();
    } catch {
      toast.error('Failed to clear one thing');
    }
  }

  if (dismissed || loading) return null;
  if (!oneThing && source === 'none') return null;

  const isCompleted = oneThing?.status === 'done' || !!oneThing?.completedAt;

  const bannerContent = (
    <motion.div
      variants={isCompleted ? oneThingCelebration : oneThingGlow}
      initial="idle"
      animate={prefersReducedMotion
        ? 'idle'
        : celebrating
          ? 'celebrate'
          : (isCompleted ? 'idle' : 'glow')}
      className={`relative overflow-hidden ${embedded ? 'rounded-b-[var(--radius-lg)]' : 'rounded-xl'} border-0 p-4 ${
        isCompleted
          ? 'bg-emerald-950/40'
          : 'bg-gradient-to-r from-[var(--surface-1)] via-[var(--surface-1)] to-blue-950/20'
      }`}
      >
        {/* Celebration confetti particles */}
        <AnimatePresence>
          {celebrating && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              {CONFETTI_EMOJIS.map((emoji, i) => (
                <motion.span
                  key={i}
                  custom={i}
                  variants={oneThingConfetti}
                  initial="hidden"
                  animate="show"
                  exit="hidden"
                  className="absolute top-1/2 text-lg"
                  style={{ left: `${15 + i * 14}%` }}
                >
                  {emoji}
                </motion.span>
              ))}
            </div>
          )}
        </AnimatePresence>

        <div className="flex items-start gap-4">
          {/* Icon */}
          <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
            isCompleted
              ? 'bg-emerald-900/50 text-emerald-400'
              : 'bg-blue-900/40 text-blue-400'
          }`}>
            {isCompleted ? <Trophy size={20} /> : <Target size={20} />}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[12px] font-bold uppercase tracking-[0.15em] ${
                isCompleted ? 'text-emerald-400' : 'text-blue-400'
              }`}>
                {isCompleted ? <><Check size={12} className="inline" /> One Thing — Done!</> : 'This Week, One Thing'}
              </span>
              {source === 'auto' && !isCompleted && (
                <span className="text-[12px] text-[var(--text-muted)] flex items-center gap-0.5">
                  <Sparkles size={8} /> AI picked
                </span>
              )}
              {source === 'manual' && !isCompleted && (
                <span className="text-[12px] text-[var(--text-muted)]">Your pick</span>
              )}
            </div>

            <p className="mb-2 text-[12px] leading-relaxed text-[var(--text-tertiary)] text-pretty">
              {isCompleted
                ? 'You crushed your most important task this week. Everything else is a bonus.'
                : 'If you only get one thing done this week, make it this:'}
            </p>

            {oneThing && (
              <button
                onClick={() => onTaskClick?.(oneThing.taskId)}
                className="group/task flex items-center gap-2.5 w-full text-left"
              >
                <ConnectorIcon type={oneThing.connectorType} size={16} />
                <span className={`text-sm font-medium truncate ${
                  isCompleted
                    ? 'line-through text-emerald-300/70'
                    : 'text-[var(--text-primary)] group-hover/task:text-blue-300'
                } transition-colors duration-150`}>
                  {oneThing.title}
                </span>
                {oneThing.priority && oneThing.priority !== 'none' && (
                  <span className={`text-[12px] font-semibold ${getTaskPriorityVisual(oneThing.priority).textClass}`}>
                    {getTaskPriorityVisual(oneThing.priority).shortLabel}
                  </span>
                )}
                {oneThing.dueDate && !isCompleted && (
                  <span className="text-[12px] text-[var(--text-muted)] tabular-nums ml-auto flex-shrink-0">
                    Due {(() => { const _d = new Date(oneThing.dueDate.split('T')[0] + 'T12:00:00'); const _opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }; if (_d.getFullYear() !== new Date().getFullYear()) _opts.year = 'numeric'; return _d.toLocaleDateString('en-US', _opts); })()}
                  </span>
                )}
                {isCompleted && (
                  <CheckCircle2 size={14} className="text-emerald-400 ml-auto flex-shrink-0" />
                )}
                {!isCompleted && (
                  <ArrowRight size={12} className="text-[var(--text-muted)] opacity-0 group-hover/task:opacity-100 transition-opacity duration-150 flex-shrink-0" />
                )}
              </button>
            )}

            {/* Subtask progress bar */}
            {oneThing && !isCompleted && (oneThing.subtaskTotal ?? 0) > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-blue-900/30 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-blue-400"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.round(((oneThing.subtaskDone ?? 0) / (oneThing.subtaskTotal || 1)) * 100)}%` }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                  />
                </div>
                <span className="text-xs text-[var(--text-muted)] tabular-nums flex-shrink-0">
                  {oneThing.subtaskDone}/{oneThing.subtaskTotal}
                </span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {!isCompleted && (
              <Tooltip content="Swap your one thing">
                <motion.button
                  whileTap={{ scale: 0.96 }}
                  onClick={() => {
                    setShowSwapPicker(!showSwapPicker);
                    if (!showSwapPicker) searchTasks('');
                  }}
                  className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-[background-color,color] duration-150"
                >
                  <Shuffle size={13} />
                </motion.button>
              </Tooltip>
            )}
            {!embedded && (
              <Tooltip content="Dismiss banner">
                <button
                  onClick={() => setDismissed(true)}
                  className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-[background-color,color] duration-150"
                >
                  <X size={13} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Swap picker dropdown */}
        <AnimatePresence>
          {showSwapPicker && (
            <motion.div
              variants={scaleIn}
              initial="hidden"
              animate="show"
              exit="exit"
              className="mt-3 pt-3 border-t border-[var(--border-subtle)]"
            >
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearchInput(e.target.value)}
                  placeholder="Search tasks to swap in…"
                  className="flex-1 text-xs bg-[var(--surface-0)] border border-[var(--border)] rounded-md px-3 py-1.5 outline-none focus:border-blue-500/50 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] transition-[border-color] duration-150"
                  autoFocus
                />
                <button
                  onClick={() => { setShowSwapPicker(false); setSearchQuery(''); setSearchResults([]); }}
                  className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] px-2 py-1"
                >
                  Cancel
                </button>
              </div>

              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {searching && (
                  <div className="flex items-center justify-center py-3 text-[var(--text-muted)]">
                    <Loader2 size={14} className="animate-spin" />
                  </div>
                )}
                {!searching && searchResults.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)] py-2 text-center">No tasks found</p>
                )}
                {!searching && searchResults.map(task => (
                  <button
                    key={task.id}
                    onClick={() => swapOneThing(task.id)}
                    disabled={task.id === oneThing?.taskId}
                    className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-[var(--surface-2)] transition-[background-color] duration-100 text-left group/swap disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ConnectorIcon type={task.connectorType} size={12} />
                    {task.priority && task.priority !== 'none' && (
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${getTaskPriorityVisual(task.priority).dotClass}`} />
                    )}
                    <span className="text-xs text-[var(--text-primary)] truncate flex-1">{task.title}</span>
                    <ChevronDown size={10} className="text-[var(--text-muted)] opacity-0 group-hover/swap:opacity-100 transition-opacity rotate-[-90deg]" />
                  </button>
                ))}
              </div>

              {oneThing?.isManualOverride && (
                <button
                  onClick={clearOneThing}
                  className="mt-2 w-full text-xs text-[var(--text-tertiary)] hover:text-amber-400 py-1.5 flex items-center justify-center gap-1 transition-colors duration-150"
                >
                  <Sparkles size={10} /> Reset to AI pick
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
  );

  if (embedded) return collapsed ? null : bannerContent;

  return (
    <motion.div
      variants={fadeSlideUp}
      initial="hidden"
      animate="show"
      className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] overflow-hidden"
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-[var(--surface-2)] transition-colors duration-75 select-none"
        aria-expanded={!collapsed}
      >
        <ChevronRight
          size={14}
          className={`text-[var(--text-secondary)] transition-transform duration-150 flex-shrink-0 ${!collapsed ? 'rotate-90' : ''}`}
        />
        <Target size={14} className="text-blue-400 flex-shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
          One Thing
        </span>
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="onething-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            {bannerContent}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
