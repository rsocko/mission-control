'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Moon, Calendar, Check, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import { useViewMode } from '@/lib/hooks/useViewMode';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import type { TaskEditPolicy } from '@/types';
import { canEditTaskField, taskFieldBlockedReason } from '@/lib/tasks/client-edit-policy';
import { fetchAllTasks } from '@/lib/tasks/fetch-all';
import { getTaskPriorityVisual } from '@/lib/constants/task-formatting';

interface CalmTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  editPolicy: TaskEditPolicy;
}

const ENCOURAGEMENTS = [
  'That counts.',
  'One down. Keep going.',
  "Nice. What's next?",
  'Progress.',
  "You're moving.",
];

function getEncouragement(count: number): string {
  return ENCOURAGEMENTS[count % ENCOURAGEMENTS.length];
}

export function CalmMode() {
  const { viewMode, calmScope, setViewMode } = useViewMode();
  const [tasks, setTasks] = useState<CalmTask[]>([]);
  const [loading, setLoading] = useState(true);
  const { completingIds, runTaskCompletion } = useTaskCompletion();
  const [completedCount, setCompletedCount] = useState(0);
  const [listDepleted, setListDepleted] = useState(false);
  const calmScopeKey = JSON.stringify(calmScope);
  const calmScopeKeyRef = useRef(calmScopeKey);
  calmScopeKeyRef.current = calmScopeKey;

  const fetchTopTasks = useCallback(async () => {
    setLoading(true);
    try {
      let fetched: CalmTask[] = [];

      if (calmScope.type === 'project' && calmScope.projectId) {
        // Scoped to a specific project
        const res = await fetch(`/api/smart-score?limit=5&status=open&projectId=${calmScope.projectId}`);
        const data = await res.json();
        fetched = (data.scores || []).slice(0, 5).map((s: { taskId: string; task: { title: string; priority: string; dueDate: string | null; editPolicy: TaskEditPolicy } | null }) => ({
          id: s.taskId,
          title: s.task?.title || '',
          priority: s.task?.priority || 'none',
          dueDate: s.task?.dueDate || null,
          editPolicy: s.task!.editPolicy,
        }));
      } else if ((calmScope.type === 'my-day' || calmScope.type === 'focus3') && calmScope.taskIds?.length) {
        // Pre-loaded task IDs — fetch their details
        const params = calmScope.taskIds.map((id) => `ids=${id}`).join('&');
        const scopedTasks = await fetchAllTasks<CalmTask>(`/api/tasks?${params}`);
        fetched = scopedTasks.map((t) => ({
          id: t.id,
          title: t.title || '',
          priority: t.priority || 'none',
          dueDate: t.dueDate || null,
          editPolicy: t.editPolicy,
        }));
      } else {
        // Global — top 5 by Smart Score
        const res = await fetch('/api/smart-score?limit=5&status=open');
        const data = await res.json();
        fetched = (data.scores || []).slice(0, 5).map((s: { taskId: string; task: { title: string; priority: string; dueDate: string | null; editPolicy: TaskEditPolicy } | null }) => ({
          id: s.taskId,
          title: s.task?.title || '',
          priority: s.task?.priority || 'none',
          dueDate: s.task?.dueDate || null,
          editPolicy: s.task!.editPolicy,
        }));
      }

      setTasks(fetched);
      setListDepleted(false);
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [calmScope]);

  useEffect(() => {
    if (viewMode === 'calm') {
      fetchTopTasks();
      setCompletedCount(0);
      setListDepleted(false);
    }
  }, [viewMode, fetchTopTasks]);

  // Escape to exit
  useEffect(() => {
    if (viewMode !== 'calm') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewMode('normal');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [viewMode, setViewMode]);

  const removeTask = useCallback((taskId: string) => {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== taskId);
      if (next.length === 0) {
        setListDepleted(true);
      }
      return next;
    });
  }, []);

  const completeTask = useCallback(async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || completingIds.size > 0) return;
    if (!canEditTaskField(task.editPolicy, 'status')) {
      toast.error(taskFieldBlockedReason(task.editPolicy, 'status'));
      return;
    }

    const taskIndex = tasks.findIndex((candidate) => candidate.id === taskId);
    const scopeKey = calmScopeKey;
    const outcome = await runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        if (calmScopeKeyRef.current !== scopeKey) return;
        removeTask(taskId);
        setCompletedCount((count) => count + 1);
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
        if (calmScopeKeyRef.current !== scopeKey) return;
        setTasks((current) => {
          if (current.some((candidate) => candidate.id === taskId)) return current;
          const next = [...current];
          next.splice(Math.min(taskIndex, next.length), 0, task);
          return next;
        });
        setCompletedCount((count) => Math.max(0, count - 1));
        setListDepleted(false);
      },
    });

    if (outcome === 'completed') {
      window.dispatchEvent(new CustomEvent('mc:task-completed'));
    } else if (outcome === 'failed') {
      toast.error('Failed to complete task');
    }
  }, [tasks, completingIds, removeTask, runTaskCompletion]);

  const skipTask = useCallback((taskId: string) => {
    removeTask(taskId);
  }, [removeTask]);

  const loadMore = useCallback(() => {
    fetchTopTasks();
  }, [fetchTopTasks]);

  return (
    <AnimatePresence>
      {viewMode === 'calm' && (
        <motion.div
          className="fixed inset-0 z-[100] bg-[#020617] flex flex-col items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Exit button (top-right) */}
          <button
            onClick={() => setViewMode('normal')}
            className="absolute top-4 right-4 flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 bg-slate-900/50 hover:bg-slate-800/50 border border-slate-800 rounded-lg transition-colors"
          >
            <X size={14} />
            Exit <kbd className="ml-1 px-1 py-0.5 bg-slate-800 rounded text-xs font-mono">Esc</kbd>
          </button>

          {/* Centered content */}
          <div className="w-full max-w-md px-6">
            <div className="flex items-center gap-2 mb-8">
              <Moon size={20} className="text-slate-500" />
              <h1 className="text-lg font-medium text-slate-400">What matters now</h1>
              {calmScope.type !== 'global' && (
                <span className="text-xs text-slate-600 bg-slate-800/50 px-2 py-0.5 rounded-full">
                  {calmScope.label || calmScope.type}
                </span>
              )}
            </div>

            {loading ? (
              <div className="space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-xl bg-slate-900/60 animate-pulse" />
                ))}
              </div>
            ) : listDepleted ? (
              /* All items cleared — ask before showing more */
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="text-center py-12"
              >
                <Check size={36} className="mx-auto mb-4 text-green-400/70" />
                <p className="text-base text-slate-300 font-medium mb-1">
                  List clear.
                </p>
                <p className="text-sm text-slate-500 mb-8">
                  {completedCount > 0
                    ? `${completedCount} done — that's enough if you want it to be.`
                    : 'Nothing pressing right now.'}
                </p>
                <div className="flex items-center justify-center gap-3">
                  {(calmScope.type === 'global' || calmScope.type === 'project') && (
                    <button
                      onClick={loadMore}
                      className="px-5 py-2.5 text-sm font-medium text-slate-300 bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700 rounded-xl transition-colors"
                    >
                      Show me more
                    </button>
                  )}
                  <button
                    onClick={() => setViewMode('normal')}
                    className="px-5 py-2.5 text-sm font-medium text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    I’m done for now
                  </button>
                </div>
              </motion.div>
            ) : tasks.length === 0 ? (
              <div className="text-center py-16">
                <Moon size={32} className="mx-auto mb-3 text-slate-700" />
                <p className="text-sm text-slate-600">Nothing pressing right now</p>
              </div>
            ) : (
              <div className="space-y-3">
                <AnimatePresence initial={false}>
                  {tasks.map((task, i) => {
                    const isCompleting = completingIds.has(task.id);
                    return (
                      <motion.div
                        key={task.id}
                        layout
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: isCompleting ? 0.5 : 1, y: 0 }}
                        exit={{ opacity: 0, x: -30, height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
                        transition={{ delay: i * 0.05, duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
                        className={`flex items-center gap-4 px-5 py-4 rounded-xl bg-slate-900/40 border border-slate-800/50 group ${isCompleting ? 'bg-green-900/20 border-green-800/30' : ''}`}
                      >
                        {/* Complete button */}
                        <CompletionBurst celebrating={isCompleting}>
                          <button
                            onClick={() => completeTask(task.id)}
                            disabled={completingIds.size > 0 || !canEditTaskField(task.editPolicy, 'status')}
                            title={!canEditTaskField(task.editPolicy, 'status') ? taskFieldBlockedReason(task.editPolicy, 'status') : undefined}
                            className={`w-6 h-6 rounded-full border-2 flex-shrink-0 transition-[border-color,background-color,color] duration-200 flex items-center justify-center cursor-pointer ${
                              isCompleting
                                ? 'border-green-400 bg-green-400 text-white'
                                : 'border-slate-600 hover:border-green-500 hover:bg-green-900/30'
                            }`}
                            aria-label={`Complete "${task.title}"`}
                          >
                            {isCompleting && <Check size={12} />}
                          </button>
                        </CompletionBurst>

                        {/* Priority dot + title */}
                        {task.priority !== 'none' && (
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getTaskPriorityVisual(task.priority).dotClass}`} />
                        )}
                        <p className="flex-1 text-[15px] text-slate-300 font-medium leading-snug">
                          {task.title}
                        </p>

                        {/* Due date */}
                        {task.dueDate && (
                          <span className="flex items-center gap-1 text-xs text-slate-600 flex-shrink-0">
                            <Calendar size={11} />
                            {new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                        )}

                        {/* Skip button — visible on hover */}
                        <button
                          onClick={() => skipTask(task.id)}
                          disabled={completingIds.size > 0}
                          className="flex-shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity p-1 text-slate-600 hover:text-slate-400 cursor-pointer"
                          aria-label={`Skip "${task.title}"`}
                          title="Not today"
                        >
                          <SkipForward size={14} />
                        </button>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}

            {/* Completion counter — only when tasks are showing and some are done */}
            {!listDepleted && !loading && tasks.length > 0 && completedCount > 0 && (
              <motion.p
                key={completedCount}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center text-xs text-slate-600 mt-8"
              >
                <Check size={12} className="inline" /> {completedCount} done — {getEncouragement(completedCount - 1)}
              </motion.p>
            )}

            {/* Guidance text — only when list is active */}
            {!listDepleted && !loading && tasks.length > 0 && completedCount === 0 && (
              <p className="text-center text-xs text-slate-700 mt-10">
                Focus on one at a time
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
