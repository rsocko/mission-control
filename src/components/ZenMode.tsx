'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Zap, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useViewMode } from '@/lib/hooks/useViewMode';
import { useTaskCompletion } from '@/lib/hooks/useTaskCompletion';
import { SmartScoreBadge } from '@/components/smart-score/SmartScoreBadge';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import type { ScoreBreakdown } from '@/lib/smart-score';
import type { TaskEditPolicy } from '@/types';
import { canEditTaskField, taskFieldBlockedReason } from '@/lib/tasks/client-edit-policy';

interface ZenTask {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  score: number;
  breakdown?: ScoreBreakdown;
  editPolicy: TaskEditPolicy;
}

export function ZenMode() {
  const { viewMode, setViewMode } = useViewMode();
  const [tasks, setTasks] = useState<ZenTask[]>([]);
  const [loading, setLoading] = useState(true);
  const { completingIds, runTaskCompletion } = useTaskCompletion();
  const [completedCount, setCompletedCount] = useState(0);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const fetchScoreSortedTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/smart-score?limit=50&status=open');
      const data = await res.json();
      setTasks(
        (data.scores || []).map((s: { taskId: string; task: { title: string; priority: string; dueDate: string | null; editPolicy: TaskEditPolicy } | null; score: ScoreBreakdown }) => ({
          id: s.taskId,
          title: s.task?.title || '',
          priority: s.task?.priority || 'none',
          dueDate: s.task?.dueDate || null,
          score: s.score.total,
          breakdown: s.score,
          editPolicy: s.task!.editPolicy,
        }))
      );
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewMode === 'zen') {
      fetchScoreSortedTasks();
      setCompletedCount(0);
    }
  }, [viewMode, fetchScoreSortedTasks]);

  // Escape to exit
  useEffect(() => {
    if (viewMode !== 'zen') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewMode('normal');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [viewMode, setViewMode]);

  const completeTask = useCallback(async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (!canEditTaskField(task.editPolicy, 'status')) {
      toast.error(taskFieldBlockedReason(task.editPolicy, 'status'));
      return;
    }

    const taskIndex = tasks.findIndex((candidate) => candidate.id === taskId);
    const outcome = await runTaskCompletion(taskId, {
      optimisticUpdate: () => {
        setTasks((current) => current.filter((candidate) => candidate.id !== taskId));
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
        setTasks((current) => {
          if (current.some((candidate) => candidate.id === taskId)) return current;
          const next = [...current];
          next.splice(taskIndex, 0, task);
          return next;
        });
        setCompletedCount((count) => Math.max(0, count - 1));
      },
    });

    if (outcome === 'completed') {
      window.dispatchEvent(new CustomEvent('mc:task-completed'));
      toast.success(`"${task.title}" completed`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            await fetch(`/api/tasks/${taskId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'todo' }),
            });
            setCompletedCount((c) => Math.max(0, c - 1));
            fetchScoreSortedTasks();
            window.dispatchEvent(new CustomEvent('mc:task-completed'));
          },
        },
        duration: 5000,
      });
    } else if (outcome === 'failed') {
      toast.error('Failed to complete task');
    }
  }, [tasks, fetchScoreSortedTasks, runTaskCompletion]);

  const openTask = useCallback((taskId: string) => {
    setOpenTaskId(taskId);
  }, []);

  return (
    <AnimatePresence>
      {viewMode === 'zen' && (
        <motion.div
          className="fixed inset-0 z-[100] bg-[var(--background)] flex flex-col"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Minimal header */}
          <div className="flex items-center justify-between px-8 py-4 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2">
              <Zap size={18} className="text-blue-400" />
              <h1 className="text-lg font-semibold text-[var(--text-primary)]">Zen Mode</h1>
              <span className="text-xs text-[var(--text-muted)]">
                Score-sorted · {tasks.length} remaining
                {completedCount > 0 && (
                  <span className="ml-2 text-green-400">· <Check size={12} className="inline" /> {completedCount} done</span>
                )}
              </span>
            </div>
            <button
              onClick={() => setViewMode('normal')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border)] rounded-lg transition-colors"
            >
              <X size={14} />
              Exit <kbd className="ml-1 px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs font-mono">Esc</kbd>
            </button>
          </div>

          {/* Score-sorted task list */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            <div className="max-w-2xl mx-auto space-y-1">
              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-14 rounded-lg bg-[var(--surface-1)] animate-pulse" />
                  ))}
                </div>
              ) : tasks.length === 0 ? (
                <div className="text-center py-20 text-[var(--text-muted)]">
                  <Zap size={32} className="mx-auto mb-3 opacity-30" />
                  {completedCount > 0 ? (
                    <>
                      <p className="text-sm text-green-400 font-medium">All clear — {completedCount} tasks completed 🎉</p>
                      <p className="text-xs mt-2">Press Esc to return</p>
                    </>
                  ) : (
                    <p className="text-sm">No scored tasks found</p>
                  )}
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {tasks.map((task, i) => {
                    const isCompleting = completingIds.has(task.id);
                    return (
                      <motion.div
                        key={task.id}
                        layout
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: isCompleting ? 0.5 : 1, y: 0 }}
                        exit={{ opacity: 0, x: -20, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.25 }}
                        className={`flex items-center gap-4 px-4 py-3.5 rounded-lg hover:bg-[var(--surface-1)] transition-colors group ${isCompleting ? 'bg-green-900/10' : ''}`}
                      >
                        {/* Completion circle */}
                        <CompletionBurst celebrating={isCompleting}>
                          <button
                            onClick={() => completeTask(task.id)}
                            disabled={isCompleting || !canEditTaskField(task.editPolicy, 'status')}
                            title={!canEditTaskField(task.editPolicy, 'status') ? taskFieldBlockedReason(task.editPolicy, 'status') : undefined}
                            className={`w-5 h-5 rounded-full border-2 flex-shrink-0 transition-[border-color,background-color,color] duration-200 flex items-center justify-center cursor-pointer ${
                              isCompleting
                                ? 'border-green-400 bg-green-400 text-white'
                                : 'border-[var(--border-strong)] hover:border-green-500 hover:bg-green-900/30'
                            }`}
                            aria-label={`Complete "${task.title}"`}
                          >
                            {isCompleting && <Check size={12} />}
                          </button>
                        </CompletionBurst>

                        <span className="text-xs tabular-nums text-[var(--text-muted)] w-6 text-right font-mono">
                          {i + 1}
                        </span>
                        <SmartScoreBadge score={task.score} breakdown={task.breakdown} size="sm" />
                        <button
                          onClick={() => openTask(task.id)}
                          className="flex-1 min-w-0 text-left cursor-pointer"
                        >
                          <p className="text-sm text-[var(--text-primary)] font-medium truncate group-hover:underline decoration-[var(--text-muted)]/30 underline-offset-2">
                            {task.title}
                          </p>
                        </button>
                        {task.priority !== 'none' && (
                          <span className={`text-xs font-semibold uppercase tracking-wider ${
                           task.priority === 'critical' ? 'text-rose-400' :
                           task.priority === 'high' ? 'text-orange-400' :
                           task.priority === 'medium' ? 'text-amber-300' : 'text-sky-400'
                          }`}>
                            {task.priority}
                          </span>
                        )}
                        {task.dueDate && (
                          <span className="text-xs text-[var(--text-muted)] tabular-nums">
                            {new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              )}
            </div>
          </div>

          {/* Task detail dialog overlay */}
          <AnimatePresence>
            {openTaskId && (
              <motion.div
                className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={() => setOpenTaskId(null)}
              >
                <motion.div
                  className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl bg-[var(--background)] border border-[var(--border)] shadow-2xl"
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.95, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <TaskDetailPanel
                    taskId={openTaskId}
                    onClose={() => setOpenTaskId(null)}
                    onUpdate={() => fetchScoreSortedTasks()}
                    mode="dialog"
                  />
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
