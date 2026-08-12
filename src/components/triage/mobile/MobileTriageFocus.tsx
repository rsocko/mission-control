'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  motion,
  useMotionValue,
  useTransform,
  useAnimationControls,
  useReducedMotion,
  type PanInfo,
} from 'motion/react';
import {
  Archive,
  BookOpen,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  ExternalLink,
  FolderGit2,
  LayoutGrid,
  ListChecks,
  Menu,
  MessageCircle,
  Sparkles,
  ThumbsUp,
  Workflow,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { triggerHaptic, triggerHapticFeedback } from '@/lib/utils/haptics';
import { toast } from 'sonner';
import type { TriageActionRecord, TriageActionType, TriageItem } from '@/types';
import { SOURCE_META } from '@/components/triage/types';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MobileTriageFocusProps {
  items: TriageItem[];
  onAction: (
    id: string,
    actionType: TriageActionType,
    options?: { showSuccessToast?: boolean },
  ) => Promise<TriageActionRecord | null>;
  onUndoAction: (id: string, action: TriageActionRecord) => Promise<boolean>;
  busyAction: string | null;
  loading: boolean;
  onSwitchToStream?: () => void;
}

interface SessionStats {
  processedCount: number;
  streak: number;
}

const SWIPE_ACTIONS = {
  complete_action: { label: 'Done', haptic: 'taskComplete' },
  dismiss: { label: 'Dismissed', haptic: 'delete' },
  snooze: { label: 'Snoozed', haptic: 'defer' },
} as const;

const SWIPE_UNDO_DURATION_MS = 5000;

// ─── Source brand color map ─────────────────────────────────────────────────

const SOURCE_BRAND: Record<string, { bg: string; ring: string; text: string }> = {
  reddit: { bg: 'bg-orange-500/15', ring: 'ring-orange-400/30', text: 'text-orange-200' },
  github: { bg: 'bg-violet-500/15', ring: 'ring-violet-400/30', text: 'text-violet-300' },
  youtube: { bg: 'bg-red-500/15', ring: 'ring-red-400/30', text: 'text-red-300' },
  twitter: { bg: 'bg-sky-500/15', ring: 'ring-sky-400/30', text: 'text-sky-300' },
  instagram: { bg: 'bg-pink-500/15', ring: 'ring-pink-400/30', text: 'text-pink-300' },
  facebook: { bg: 'bg-blue-500/15', ring: 'ring-blue-400/30', text: 'text-blue-300' },
  tiktok: { bg: 'bg-cyan-500/15', ring: 'ring-cyan-400/30', text: 'text-cyan-300' },
  pinterest: { bg: 'bg-rose-500/15', ring: 'ring-rose-400/30', text: 'text-rose-300' },
  web: { bg: 'bg-slate-500/15', ring: 'ring-slate-400/30', text: 'text-slate-300' },
};

// ─── Routing actions grid config (F-40, F-41) ──────────────────────────────

const ALL_ROUTING_ACTIONS: Array<{
  type: TriageActionType;
  label: string;
  icon: typeof Archive;
  color: string;
}> = [
  { type: 'save_karakeep', label: 'Karakeep', icon: Archive, color: 'text-blue-400' },
  { type: 'save_knowledge_base', label: 'KB', icon: BookOpen, color: 'text-emerald-400' },
  { type: 'create_task_github', label: 'GitHub', icon: FolderGit2, color: 'text-violet-400' },
  { type: 'create_task_todo', label: 'Task', icon: ListChecks, color: 'text-amber-400' },
  { type: 'save_model_catalog', label: 'Models', icon: Boxes, color: 'text-pink-400' },
  { type: 'trigger_workflow', label: 'Workflow', icon: Workflow, color: 'text-cyan-400' },
  { type: 'dismiss', label: 'Dismiss', icon: X, color: 'text-slate-400' },
  { type: 'snooze', label: 'Snooze', icon: Clock3, color: 'text-sky-400' },
];

// ─── Source-type action relevance (F-42) ────────────────────────────────────
// Maps source platforms to the most relevant action types for that source.
// Actions not listed for a source are placed behind "More".

const SOURCE_RELEVANT_ACTIONS: Record<string, TriageActionType[]> = {
  reddit: ['save_karakeep', 'save_knowledge_base', 'create_task_todo', 'dismiss'],
  github: ['create_task_github', 'save_knowledge_base', 'create_task_todo', 'dismiss'],
  youtube: ['save_karakeep', 'save_knowledge_base', 'create_task_todo', 'dismiss'],
  twitter: ['save_karakeep', 'save_knowledge_base', 'create_task_todo', 'dismiss'],
  instagram: ['save_karakeep', 'create_task_todo', 'dismiss', 'snooze'],
  facebook: ['save_karakeep', 'create_task_todo', 'dismiss', 'snooze'],
  tiktok: ['save_karakeep', 'create_task_todo', 'dismiss', 'snooze'],
  pinterest: ['save_karakeep', 'save_model_catalog', 'create_task_todo', 'dismiss'],
  'document-intelligence': ['save_knowledge_base', 'trigger_workflow', 'create_task_todo', 'dismiss'],
  web: ['save_karakeep', 'save_knowledge_base', 'create_task_todo', 'dismiss'],
};

function getActionsForSource(sourcePlatform: string): typeof ALL_ROUTING_ACTIONS {
  const relevantTypes = SOURCE_RELEVANT_ACTIONS[sourcePlatform] || SOURCE_RELEVANT_ACTIONS.web;
  const primary = ALL_ROUTING_ACTIONS.filter((a) => relevantTypes.includes(a.type));
  return primary;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getSourceContext(item: TriageItem): string | null {
  const meta = item.rawMetadata;
  if (meta?.subreddit) return `r/${meta.subreddit as string}`;
  if (meta?.org) return meta.org as string;
  if (meta?.channel) return meta.channel as string;
  return null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function MobileTriageFocus({
  items,
  onAction,
  onUndoAction,
  busyAction,
  loading,
  onSwitchToStream,
}: MobileTriageFocusProps) {
  const [sessionStats, setSessionStats] = useState<SessionStats>({
    processedCount: 0,
    streak: 0,
  });
  const [isDispatching, setIsDispatching] = useState(false);
  const totalCount = sessionStats.processedCount + items.length;

  const item = items[0] ?? null;
  const nextItem = items[1] ?? null;

  // Swipe motion values
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const controls = useAnimationControls();
  const prefersReducedMotion = useReducedMotion() ?? false;
  const swipeTransition = useMemo(
    () => prefersReducedMotion ? { duration: 0 } : { duration: 0.3 },
    [prefersReducedMotion],
  );

  const rotate = useTransform(x, [-200, 0, 200], [-12, 0, 12]);
  const cardOpacity = useTransform(x, [-200, -100, 0, 100, 200], [0.7, 0.9, 1, 0.9, 0.7]);

  // Overlay intensities
  const greenOverlay = useTransform(x, [0, 150], [0, 0.3]);
  const redOverlay = useTransform(x, [-150, 0], [0.3, 0]);
  const blueOverlay = useTransform(y, [-100, 0], [0.3, 0]);

  // Guard against actions firing after unmount
  const mountedRef = useRef(true);
  const dispatchingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const resetCard = useCallback(async () => {
    x.set(0);
    y.set(0);
    await controls.start({ x: 0, y: 0, opacity: 1, transition: swipeTransition });
  }, [controls, swipeTransition, x, y]);

  const dispatchSwipe = useCallback(async (
    actionType: keyof typeof SWIPE_ACTIONS,
    exit: { x?: number; y?: number },
  ) => {
    if (!item || busyAction || dispatchingRef.current) return;
    dispatchingRef.current = true;
    setIsDispatching(true);

    const actionConfig = SWIPE_ACTIONS[actionType];
    try {
      await controls.start({ ...exit, opacity: 0, transition: swipeTransition });
      const appliedAction = await onAction(item.id, actionType, { showSuccessToast: false });
      if (!appliedAction) return;
      triggerHapticFeedback(items.length === 1 ? 'triageComplete' : actionConfig.haptic);

      if (mountedRef.current) {
        setSessionStats((prev) => ({
          ...prev,
          processedCount: prev.processedCount + 1,
          streak: actionType === 'dismiss' ? 0 : prev.streak + 1,
        }));
      }

      toast.success(actionConfig.label, {
        action: {
          label: 'Undo',
          onClick: async () => {
            const undone = await onUndoAction(item.id, appliedAction);
            if (undone && mountedRef.current) {
              setSessionStats((prev) => ({
                ...prev,
                processedCount: Math.max(0, prev.processedCount - 1),
                streak: actionType === 'dismiss' ? prev.streak : Math.max(0, prev.streak - 1),
              }));
            }
          },
        },
        duration: SWIPE_UNDO_DURATION_MS,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Action failed');
    } finally {
      if (mountedRef.current) await resetCard();
      dispatchingRef.current = false;
      if (mountedRef.current) setIsDispatching(false);
    }
  }, [busyAction, controls, item, items.length, onAction, onUndoAction, resetCard, swipeTransition]);

  const handleDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      const { offset } = info;

      if (offset.x > 150) {
        void dispatchSwipe('complete_action', { x: 400 });
      } else if (offset.x < -150) {
        void dispatchSwipe('dismiss', { x: -400 });
      } else if (offset.y < -100) {
        void dispatchSwipe('snooze', { y: -400 });
      } else {
        void resetCard();
      }
    },
    [dispatchSwipe, resetCard],
  );

  const handleCardKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const action = event.key === 'ArrowRight'
      ? ['complete_action', { x: 400 }] as const
      : event.key === 'ArrowLeft'
        ? ['dismiss', { x: -400 }] as const
        : event.key === 'ArrowUp'
          ? ['snooze', { y: -400 }] as const
          : null;
    if (!action) return;
    event.preventDefault();
    const [actionType, exit] = action;
    void dispatchSwipe(actionType, exit);
  }, [dispatchSwipe]);

  // AI suggestion text
  const aiSuggestion = useMemo(() => {
    if (!item) return null;
    const action = item.aiSuggestedActions[0];
    if (!action) return null;
    return action.reason || `${action.actionType.replace(/_/g, ' ')} — matches your interests`;
  }, [item]);

  const sourceBrand = item ? SOURCE_BRAND[item.sourcePlatform] || SOURCE_BRAND.web : SOURCE_BRAND.web;
  const sourceMeta = item ? SOURCE_META[item.sourcePlatform] || SOURCE_META.web : SOURCE_META.web;
  const sourceContext = item ? getSourceContext(item) : null;

  // ─── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
      </div>
    );
  }

  // ─── Empty state ────────────────────────────────────────────────────────────

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-400/20">
          <Check size={28} className="text-emerald-400" />
        </div>
        <h2 className="text-lg font-semibold text-white">All caught up!</h2>
        <p className="text-sm text-slate-400">No triage items to process right now.</p>
      </div>
    );
  }

  // ─── Main render ────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-950 px-4 pb-4 pt-2">
      {/* Header */}
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Open menu"
            className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/5 backdrop-blur-md ring-1 ring-white/10"
          >
            <Menu size={16} className="text-slate-300" />
          </button>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Focus Mode
            </p>
            <h1 className="text-base font-bold text-white">Triage</h1>
          </div>
        </div>
        {onSwitchToStream && (
          <button
            type="button"
            onClick={onSwitchToStream}
            aria-label="Switch to stream view"
            className="flex h-9 w-9 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/5 backdrop-blur-md ring-1 ring-sky-400/30"
          >
            <LayoutGrid size={16} className="text-sky-400" />
          </button>
        )}
      </header>

      {/* Position indicator (F-39) */}
      <div className="mb-3 flex items-center justify-center gap-2">
        <p className="text-xs tabular-nums text-slate-400">
          {Math.min(sessionStats.processedCount + 1, totalCount)} of {totalCount}
          {sessionStats.streak > 2 && (
            <span className="ml-2 text-amber-400">🔥 {sessionStats.streak}</span>
          )}
        </p>
      </div>

      {/* Card stack area */}
      <div className="relative flex flex-1 flex-col items-center justify-center">
        {/* Peek card (next item) */}
        {nextItem && (
          <div
            className="absolute inset-x-4 top-6 z-0 rounded-[20px] bg-white/[0.03] p-4 opacity-40 ring-1 ring-white/5 backdrop-blur-sm"
            style={{ transform: 'scale(0.95)' }}
            aria-hidden="true"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ring-1',
                  SOURCE_BRAND[nextItem.sourcePlatform]?.bg || 'bg-slate-500/15',
                  SOURCE_BRAND[nextItem.sourcePlatform]?.ring || 'ring-slate-400/30',
                  SOURCE_BRAND[nextItem.sourcePlatform]?.text || 'text-slate-300',
                )}
              >
                <TriageSourceIcon source={nextItem.sourcePlatform} size={10} decorative />
                {(SOURCE_META[nextItem.sourcePlatform] || SOURCE_META.web).label}
              </span>
            </div>
            <p className="mt-2 line-clamp-1 text-sm text-slate-400">{nextItem.title}</p>
          </div>
        )}

        {/* Main focus card (F-35) */}
        <motion.div
          key={item.id}
          drag={!busyAction && !isDispatching}
          dragSnapToOrigin
          dragElastic={0.7}
          onDragEnd={handleDragEnd}
          onKeyDown={handleCardKeyDown}
          animate={controls}
          style={{ x, y, rotate, opacity: cardOpacity }}
          className="relative z-10 w-full touch-none rounded-[28px] bg-white/[0.04] p-5 shadow-[0_20px_50px_rgba(2,6,23,0.5)] ring-1 ring-white/5 backdrop-blur-xl"
          role="article"
          tabIndex={0}
          aria-label={`Triage item: ${item.title}. Right for Done, left for Dismiss, up for Snooze`}
        >
          {/* Swipe overlays */}
          <motion.div
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[28px] bg-emerald-500"
            style={{ opacity: greenOverlay }}
          >
            <Check size={48} className="text-white" />
          </motion.div>
          <motion.div
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[28px] bg-red-500"
            style={{ opacity: redOverlay }}
          >
            <X size={48} className="text-white" />
          </motion.div>
          <motion.div
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[28px] bg-sky-500"
            style={{ opacity: blueOverlay }}
          >
            <Clock3 size={48} className="text-white" />
          </motion.div>

          {/* Card content */}
          <div className="relative z-0">
            {/* Source badge + AI score row */}
            <div className="flex items-center justify-between">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1',
                  sourceBrand.bg,
                  sourceBrand.ring,
                  sourceBrand.text,
                )}
              >
                <TriageSourceIcon source={item.sourcePlatform} size={12} decorative />
                {sourceMeta.label}
              </span>
              <div className="flex items-center gap-2 text-xs">
                <span className="font-bold text-sky-300">{item.aiRelevanceScore}</span>
                {sourceContext && (
                  <span className="text-[var(--text-muted)]">{sourceContext}</span>
                )}
                <span className="text-[var(--text-muted)]">{formatTimeAgo(item.capturedAt)}</span>
              </div>
            </div>

            {/* Title */}
            <h2 className="mt-4 text-xl font-semibold leading-7 text-white">
              {item.title}
            </h2>

            {/* Description */}
            {(item.aiSummary || item.description) && (
              <p className="mt-3 line-clamp-3 text-sm leading-5 text-slate-300">
                {item.aiSummary || item.description}
              </p>
            )}

            {/* Metadata chips */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.contentType && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs text-slate-400 ring-1 ring-white/5">
                  <ExternalLink size={10} />
                  {item.contentType}
                </span>
              )}
              {item.rawMetadata?.upvotes != null && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs text-slate-400 ring-1 ring-white/5">
                  <ThumbsUp size={10} />
                  {String(item.rawMetadata.upvotes)}
                </span>
              )}
              {item.rawMetadata?.commentCount != null && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs text-slate-400 ring-1 ring-white/5">
                  <MessageCircle size={10} />
                  {String(item.rawMetadata.commentCount)}
                </span>
              )}
            </div>

            {/* AI suggestion panel (F-37) */}
            {aiSuggestion && (
              <div className="mt-4 rounded-[16px] bg-sky-500/[0.08] p-3 ring-1 ring-sky-400/15">
                <div className="flex items-center gap-1.5">
                  <Sparkles size={12} className="text-sky-200" />
                  <span className="text-xs font-semibold text-sky-300">
                    Houston suggests
                  </span>
                </div>
                <p className="mt-1 text-xs leading-4 text-slate-300">{aiSuggestion}</p>
              </div>
            )}

            {/* Swipe direction indicators */}
            <div className="mt-4 flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span className="flex items-center gap-0.5">
                <ChevronLeft size={10} />
                Dismiss
              </span>
              <span className="flex flex-col items-center gap-0">
                <ChevronUp size={10} />
                Snooze
              </span>
              <span className="flex items-center gap-0.5">
                Done
                <ChevronRight size={10} />
              </span>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Routing actions grid (F-40, F-41, F-42: source-aware actions) */}
      {(() => {
        const sourceActions = getActionsForSource(item.sourcePlatform);
        const overflowActions = ALL_ROUTING_ACTIONS.filter(
          (a) => !sourceActions.some((s) => s.type === a.type),
        );
        return (
          <>
            <div className="mt-4 grid grid-cols-4 gap-2">
              {sourceActions.map(({ type, label, icon: Icon, color }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    if (item) {
                      triggerHaptic(type === 'dismiss' ? 'heavy' : 'light');
                      if (!dispatchingRef.current && !busyAction) {
                        dispatchingRef.current = true;
                        setIsDispatching(true);
                        void onAction(item.id, type)
                          .catch((error) => {
                            toast.error(error instanceof Error ? error.message : 'Action failed');
                            return null;
                          })
                          .finally(() => {
                            dispatchingRef.current = false;
                            if (mountedRef.current) setIsDispatching(false);
                          });
                      }
                    }
                  }}
                  disabled={!!busyAction}
                  aria-label={label}
                  className="flex flex-col items-center gap-1.5 rounded-[18px] bg-white/[0.04] px-2 py-3 ring-1 ring-white/5 backdrop-blur-sm transition-all active:scale-95 disabled:opacity-40"
                >
                  <Icon size={16} className={color} />
                  <span className="text-[0.625rem] font-medium text-slate-400">{label}</span>
                </button>
              ))}
            </div>
            {overflowActions.length > 0 && (
              <div className="mt-2 grid grid-cols-4 gap-2">
                {overflowActions.map(({ type, label, icon: Icon, color }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      if (item) {
                        triggerHaptic(type === 'dismiss' ? 'heavy' : 'light');
                        if (!dispatchingRef.current && !busyAction) {
                          dispatchingRef.current = true;
                          setIsDispatching(true);
                          void onAction(item.id, type)
                            .catch((error) => {
                              toast.error(error instanceof Error ? error.message : 'Action failed');
                              return null;
                            })
                            .finally(() => {
                              dispatchingRef.current = false;
                              if (mountedRef.current) setIsDispatching(false);
                            });
                        }
                      }
                    }}
                    disabled={!!busyAction}
                    aria-label={label}
                    className="flex flex-col items-center gap-1.5 rounded-[18px] bg-white/[0.04] px-2 py-3 ring-1 ring-white/5 backdrop-blur-sm transition-all active:scale-95 disabled:opacity-40"
                  >
                    <Icon size={16} className={color} />
                    <span className="text-[0.625rem] font-medium text-slate-400">{label}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
