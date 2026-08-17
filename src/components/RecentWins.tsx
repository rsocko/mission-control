'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Check, X, ChevronDown, ChevronRight, Clock, Zap, Flame, Settings, Plus, Trash2 } from 'lucide-react';
import { staggerContainer, fadeSlideUp, dropdownVariants } from '@/lib/motion';
import { Tooltip } from '@/components/ui/Tooltip';
import type { TaskPriority } from '@/types';
import { getTaskPriorityVisual } from '@/lib/constants/task-formatting';

// ─── Types ──────────────────────────────────────────────────────────────────

interface WinItem {
  id: string;
  title: string;
  priority: TaskPriority;
  connectorType: string;
  sourceListName: string | null;
  badge: string | null;
  score: number;
}

interface WinGroup {
  connectorType: string;
  listName: string;
  count: number;
}

interface WinsData {
  totalCount: number;
  items: WinItem[];
  groups: WinGroup[];
  snoozed?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BADGE_CONFIG: Record<string, { icon: typeof Flame; label: string; className: string }> = {
  'overdue cleared': { icon: Flame, label: 'overdue cleared', className: 'text-orange-400' },
  'done early': { icon: Zap, label: 'done early', className: 'text-sky-400' },
  'on time': { icon: Clock, label: 'on time', className: 'text-emerald-400' },
};

// Rotate displayed items every 30 minutes (matches API seed)
const ROTATION_INTERVAL_MS = 30 * 60 * 1000;

// Soft colors for group summary pills — cycles through a palette
const GROUP_PILL_COLORS = [
  'bg-blue-950/30 border-blue-800/40 text-blue-400',
  'bg-purple-950/30 border-purple-800/40 text-purple-400',
  'bg-amber-950/30 border-amber-800/40 text-amber-400',
  'bg-cyan-950/30 border-cyan-800/40 text-cyan-400',
  'bg-rose-950/30 border-rose-800/40 text-rose-400',
];

// ─── Component ──────────────────────────────────────────────────────────────

export function RecentWins({
  onTaskClick,
  embedded,
  collapsed,
  onToggleCollapse,
}: {
  onTaskClick?: (taskId: string) => void;
  embedded?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [data, setData] = useState<WinsData>({ totalCount: 0, items: [], groups: [] });
  const [loading, setLoading] = useState(true);
  const [hiddenThisSession, setHiddenThisSession] = useState(false);
  const [showDismissMenu, setShowDismissMenu] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [deprioritizedLists, setDeprioritizedLists] = useState<string[]>([]);
  const [newListName, setNewListName] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const dismissRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  const fetchWins = useCallback(async () => {
    try {
      const res = await fetch('/api/recent-wins');
      const json = await res.json();
      setData({
        totalCount: json.totalCount || 0,
        items: json.items || [],
        groups: json.groups || [],
        snoozed: json.snoozed || false,
      });
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWins();
  }, [fetchWins]);

  // Periodic rotation — refetch when the 30-minute window changes
  useEffect(() => {
    const interval = setInterval(() => {
      fetchWins();
    }, ROTATION_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchWins]);

  // Listen for task completions
  useEffect(() => {
    function handleCompletion() {
      fetchWins();
    }
    window.addEventListener('mc:task-completed', handleCompletion);
    return () => window.removeEventListener('mc:task-completed', handleCompletion);
  }, [fetchWins]);

  // Close dismiss menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dismissRef.current && !dismissRef.current.contains(e.target as Node)) {
        setShowDismissMenu(false);
      }
    }
    if (showDismissMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDismissMenu]);

  // Close settings panel on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    }
    if (showSettings) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSettings]);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/recent-wins/settings');
      const json = await res.json();
      setDeprioritizedLists(json.deprioritizedLists || []);
    } catch {
      // Silently fail
    }
  }, []);

  async function openSettings() {
    setShowSettings(true);
    await fetchSettings();
  }

  async function saveDeprioritizedLists(lists: string[]) {
    setSavingSettings(true);
    try {
      await fetch('/api/recent-wins/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deprioritizedLists: lists }),
      });
      setDeprioritizedLists(lists);
      await fetchWins();
    } catch {
      // Silently fail
    } finally {
      setSavingSettings(false);
    }
  }

  function addDeprioritizedList() {
    const name = newListName.trim();
    if (!name || deprioritizedLists.some((n) => n.toLowerCase() === name.toLowerCase())) return;
    const updated = [...deprioritizedLists, name];
    setNewListName('');
    void saveDeprioritizedLists(updated);
  }

  function removeDeprioritizedList(name: string) {
    void saveDeprioritizedLists(deprioritizedLists.filter((n) => n !== name));
  }

  const handleDismiss = useCallback(async (action: string) => {
    setDismissing(true);
    setShowDismissMenu(false);

    if (action === 'hide-session') {
      setHiddenThisSession(true);
      setDismissing(false);
      return;
    }

    try {
      await fetch('/api/recent-wins/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      await fetchWins();
    } catch {
      // Silently fail
    } finally {
      setDismissing(false);
    }
  }, [fetchWins]);

  // ── Don't render ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="bg-[var(--surface-1)] rounded-lg border border-[var(--border)] p-3 mb-4">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-[var(--surface-3)] animate-pulse" />
          <div className="h-4 w-28 rounded bg-[var(--surface-3)] animate-pulse" />
        </div>
      </div>
    );
  }

  if (data.totalCount === 0 || data.snoozed || hiddenThisSession) {
    return null;
  }

  // ── Determine what to show ────────────────────────────────────────────────
  // Show 1–3 actual task pills based on item quality (score > 0 preferred)
  const worthyItems = data.items.filter((item) => item.score > 0);
  const displayItems = worthyItems.length > 0
    ? worthyItems.slice(0, 3)
    : data.items.slice(0, 1); // Always show at least 1

  const remainingCount = data.totalCount - displayItems.length;

  // Build list summary counts for non-displayed lists
  const displayedListNames = new Set(displayItems.map((i) => i.sourceListName));
  const listSummaries = data.groups
    .filter((g) => !displayedListNames.has(g.listName))
    .slice(0, 2);

  const winsContent = (
    <motion.div
      className="flex flex-wrap items-center gap-1.5 p-3"
      variants={staggerContainer}
      initial="hidden"
      animate="show"
    >
      {displayItems.map((item) => {
        const badgeInfo = item.badge ? BADGE_CONFIG[item.badge] : null;
        const isClickable = !!onTaskClick;
        return (
          <motion.button
            key={item.id}
            type="button"
            variants={fadeSlideUp}
            onClick={() => onTaskClick?.(item.id)}
            disabled={!isClickable}
            className={`inline-flex items-center gap-1.5 rounded-full border text-xs px-2.5 py-1 bg-emerald-950/30 border-emerald-800/40 text-emerald-400 max-w-[280px] ${
              isClickable ? 'cursor-pointer hover:bg-emerald-900/40 hover:border-emerald-700/50 transition-[background-color,border-color] duration-150' : ''
            }`}
          >
            <Check
              size={11}
              strokeWidth={3}
              className={`shrink-0 ${getTaskPriorityVisual(item.priority).textClass}`}
            />
            <span className="truncate max-w-[180px]" title={item.title}>
              {item.title}
            </span>
            {badgeInfo && (
              <span
                className={`inline-flex items-center gap-0.5 text-[12px] ${badgeInfo.className} opacity-80`}
                title={badgeInfo.label}
              >
                <badgeInfo.icon size={9} />
              </span>
            )}
          </motion.button>
        );
      })}

      {/* List summary counts */}
      {listSummaries.map((group, idx) => (
        <motion.span
          key={`${group.connectorType}-${group.listName}`}
          variants={fadeSlideUp}
          className={`inline-flex items-center rounded-full border text-xs px-2.5 py-1 ${GROUP_PILL_COLORS[idx % GROUP_PILL_COLORS.length]}`}
        >
          {group.count} from {group.listName}
        </motion.span>
      ))}

      {remainingCount > 0 && listSummaries.length === 0 && (
        <motion.span
          variants={fadeSlideUp}
          className="inline-flex items-center rounded-full border text-xs px-2.5 py-1 border-[var(--border)] text-[var(--text-tertiary)]"
        >
          +{remainingCount} more
        </motion.span>
      )}
    </motion.div>
  );

  if (embedded) return collapsed ? null : winsContent;

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] overflow-hidden group/wins">
      <div className="flex items-center justify-between px-4 py-2.5">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          {onToggleCollapse && (
            <ChevronRight
              size={14}
              className={`text-[var(--text-secondary)] transition-transform duration-150 ${!collapsed ? 'rotate-90' : ''}`}
            />
          )}
          <Trophy size={14} className="text-amber-500" />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Recent Wins
          </span>
        </button>

        <div className="flex items-center gap-2">
          <span className="text-sm text-emerald-400 tabular-nums font-semibold">
            {data.totalCount} completed this week
          </span>

          {/* Settings */}
          <div className="relative" ref={settingsRef}>
            <Tooltip content="Manage deprioritized lists">
              <button
                onClick={openSettings}
                className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors opacity-0 group-hover/wins:opacity-100"
                aria-label="Recent wins settings"
              >
                <Settings size={12} />
              </button>
            </Tooltip>

            <AnimatePresence>
              {showSettings && (
                <motion.div
                  variants={dropdownVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] shadow-lg p-3"
                >
                  <p className="text-xs font-semibold text-[var(--text-primary)] mb-2">Deprioritized Lists</p>
                  <p className="text-xs text-[var(--text-muted)] mb-2">
                    Completions from these lists won&apos;t be highlighted.
                  </p>
                  <div className="space-y-1 mb-2 max-h-32 overflow-y-auto">
                    {deprioritizedLists.length === 0 && (
                      <p className="text-xs text-[var(--text-muted)] italic py-1">None configured</p>
                    )}
                    {deprioritizedLists.map((name) => (
                      <div key={name} className="flex items-center justify-between gap-1 px-2 py-1 rounded bg-[var(--surface-3)] text-xs text-[var(--text-secondary)]">
                        <span className="truncate">{name}</span>
                        <button
                          onClick={() => removeDeprioritizedList(name)}
                          disabled={savingSettings}
                          className="text-[var(--text-muted)] hover:text-red-400 transition-colors flex-shrink-0"
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={newListName}
                      onChange={(e) => setNewListName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addDeprioritizedList(); }}
                      placeholder="List name…"
                      className="flex-1 text-xs bg-[var(--surface-0)] border border-[var(--border)] rounded px-2 py-1 outline-none focus:border-blue-500/50 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] transition-[border-color] duration-150"
                    />
                    <button
                      onClick={addDeprioritizedList}
                      disabled={!newListName.trim() || savingSettings}
                      className="p-1 rounded text-blue-400 hover:bg-blue-900/30 transition-colors disabled:opacity-30"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Dismiss / Snooze */}
          <div className="relative" ref={dismissRef}>
            <div className="flex items-center opacity-0 group-hover/wins:opacity-100 transition-opacity">
              <Tooltip content="Hide for now">
                <button
                  onClick={() => handleDismiss('hide-session')}
                  disabled={dismissing}
                  className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                  aria-label="Hide recent wins"
                >
                  <X size={12} />
                </button>
              </Tooltip>
              <Tooltip content="Snooze options">
                <button
                  onClick={() => setShowDismissMenu((prev) => !prev)}
                  disabled={dismissing}
                  className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors -ml-0.5"
                  aria-label="Snooze options"
                >
                  <ChevronDown size={10} />
                </button>
              </Tooltip>
            </div>

            <AnimatePresence>
              {showDismissMenu && (
                <motion.div
                  variants={dropdownVariants}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] shadow-lg py-1"
                >
                  <button
                    onClick={() => handleDismiss('hide-session')}
                    className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)] transition-colors"
                  >
                    Hide for now
                  </button>
                  <button
                    onClick={() => handleDismiss('snooze-day')}
                    className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)] transition-colors"
                  >
                    Snooze until tomorrow
                  </button>
                  <button
                    onClick={() => handleDismiss('snooze-until-noteworthy')}
                    className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)] transition-colors"
                  >
                    Snooze until more wins
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="wins-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            {winsContent}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
