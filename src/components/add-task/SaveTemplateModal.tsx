'use client';

import { useState, useCallback, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, GripVertical, Plus } from 'lucide-react';
import { modalOverlay, modalContent } from '@/lib/motion';
import type { TemplateCategory, TemplateType } from '@/types';
import { TEMPLATE_CATEGORY_CONFIG } from '@/types';
import { taskLogger } from '@/lib/client-logger';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface TaskForTemplate {
  id: string;
  title: string;
  subtasks?: string[];
  priority?: string;
}

interface SaveTemplateModalProps {
  /** Tasks to build the template from */
  tasks: TaskForTemplate[];
  onClose: () => void;
  onSaved: () => void;
}

const ICON_OPTIONS = ['📋', '🐛', '🔍', '🚀', '📅', '🧳', '🖨️', '🏠', '⚡', '🎯', '💡', '📦'];
const CATEGORY_OPTIONS: Array<{ key: TemplateCategory; label: string }> = Object.entries(TEMPLATE_CATEGORY_CONFIG).map(
  ([key, cfg]) => ({ key: key as TemplateCategory, label: `${cfg.emoji} ${cfg.label}` })
);

export function SaveTemplateModal({ tasks, onClose, onSaved }: SaveTemplateModalProps) {
  // Auto-detect type: 1 task → single, 2+ → workflow
  const autoType: TemplateType = tasks.length > 1 ? 'workflow' : 'single';

  const [name, setName] = useState(() => {
    if (tasks.length === 1) return tasks[0].title;
    return '';
  });
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TemplateCategory>('general');
  const [type, setType] = useState<TemplateType>(autoType);
  const [icon, setIcon] = useState('📋');
  const [taskList, setTaskList] = useState<TaskForTemplate[]>(() => [...tasks]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const removeTask = useCallback((idx: number) => {
    setTaskList(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const addTask = useCallback(() => {
    if (!newTaskTitle.trim()) return;
    setTaskList(prev => [...prev, { id: `new-${Date.now()}`, title: newTaskTitle.trim() }]);
    setNewTaskTitle('');
  }, [newTaskTitle]);

  const moveTask = useCallback((fromIdx: number, toIdx: number) => {
    setTaskList(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!name.trim() || taskList.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        category,
        type,
        icon,
      };

      if (type === 'workflow') {
        body.workflowTasks = taskList.map(t => ({
          title: t.title,
          priority: t.priority || 'none',
          subtasks: t.subtasks || [],
        }));
        // Workflow templates still need a subtasks array (schema requires it)
        body.subtasks = [];
      } else {
        // Single: first task's subtasks become template steps
        if (taskList.length === 1 && taskList[0].subtasks && taskList[0].subtasks.length > 0) {
          body.subtasks = taskList[0].subtasks.map(title => ({ title }));
        } else if (taskList.length > 1) {
          // Multiple items treated as steps
          body.subtasks = taskList.map(t => ({ title: t.title }));
        } else {
          // Single task with no subtasks — save with empty steps
          body.subtasks = [];
        }
      }

      const res = await fetch('/api/subtask-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        onSaved();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Failed to save template (${res.status})`);
      }
    } catch (err) {
      taskLogger.error('Failed to save template', { err });
      setError('Network error — please try again');
    } finally {
      setIsSubmitting(false);
    }
  }, [name, description, category, type, icon, taskList, isSubmitting, onSaved, onClose]);

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[100] flex items-center justify-center"
        variants={modalOverlay}
        initial="hidden"
        animate="show"
        exit="exit"
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
        <motion.div
          className="relative z-10 w-[440px] max-h-[80vh] flex flex-col bg-[var(--surface-1)] border border-[var(--border-strong)] rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden"
          variants={modalContent}
          initial="hidden"
          animate="show"
          exit="exit"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              💾 Save as Template
            </h2>
            <button
              onClick={onClose}
              className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-1 rounded-md hover:bg-[var(--surface-2)]"
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">
                Template Name
              </label>
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g., Bug Fix Checklist"
                className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">
                Description
              </label>
              <input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Brief description of what this template is for"
                className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
              />
            </div>

            {/* Category + Type row */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">
                  Category
                </label>
                <Select
                  value={category}
                  onValueChange={value => setCategory(value as TemplateCategory)}
                >
                  <SelectTrigger aria-label="Template category" className="h-9 min-h-0 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                  {CATEGORY_OPTIONS.map(opt => (
                      <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                  ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">
                  Type
                </label>
                <div className="flex gap-1">
                  <button
                    onClick={() => setType('single')}
                    className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                      type === 'single'
                        ? 'bg-[var(--accent-900)] border-[var(--accent-500)] text-[var(--accent-400)]'
                        : 'bg-transparent border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]'
                    }`}
                  >
                    Single
                  </button>
                  <button
                    onClick={() => setType('workflow')}
                    className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                      type === 'workflow'
                        ? 'bg-purple-900/40 border-purple-500 text-purple-300'
                        : 'bg-transparent border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]'
                    }`}
                  >
                    Workflow
                  </button>
                </div>
              </div>
            </div>

            {/* Icon */}
            <div>
              <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">
                Icon
              </label>
              <div className="flex gap-1.5 flex-wrap">
                {ICON_OPTIONS.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => setIcon(emoji)}
                    className={`text-lg px-2 py-1 rounded-md border transition-colors ${
                      icon === emoji
                        ? 'bg-[var(--accent-900)] border-[var(--accent-500)]'
                        : 'bg-[var(--surface-0)] border-[var(--border)] hover:border-[var(--border-strong)]'
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            {/* Task list */}
            <div>
              <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">
                {type === 'workflow' ? 'Tasks in template' : 'Steps in template'}
              </label>
              <div className="space-y-1">
                {taskList.map((task, i) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 px-2.5 py-2 bg-[var(--surface-0)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)]"
                  >
                    <span className="text-[var(--text-muted)] cursor-grab flex-shrink-0">
                      <GripVertical size={12} />
                    </span>
                    <span className="flex-1 truncate">{task.title}</span>
                    {task.subtasks && task.subtasks.length > 0 && (
                      <span className="text-xs text-[var(--text-muted)] flex-shrink-0">
                        {task.subtasks.length} subtask{task.subtasks.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {/* Move up/down buttons */}
                    <div className="flex gap-0.5 flex-shrink-0">
                      {i > 0 && (
                        <button
                          onClick={() => moveTask(i, i - 1)}
                          className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-0.5"
                          title="Move up"
                        >↑</button>
                      )}
                      {i < taskList.length - 1 && (
                        <button
                          onClick={() => moveTask(i, i + 1)}
                          className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-0.5"
                          title="Move down"
                        >↓</button>
                      )}
                    </div>
                    <button
                      onClick={() => removeTask(i)}
                      className="text-[var(--text-muted)] hover:text-red-400 p-0.5 flex-shrink-0"
                      title="Remove"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}

                {/* Add task/step */}
                <div className="flex items-center gap-2 px-2.5 py-2 border border-dashed border-[var(--border)] rounded-lg">
                  <Plus size={12} className="text-[var(--text-muted)] flex-shrink-0" />
                  <input
                    value={newTaskTitle}
                    onChange={e => setNewTaskTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } }}
                    placeholder={`Add another ${type === 'workflow' ? 'task' : 'step'}…`}
                    className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
                  />
                  {newTaskTitle.trim() && (
                    <button
                      onClick={addTask}
                      className="text-xs text-[var(--accent-400)] hover:text-[var(--accent-300)]"
                    >
                      Add
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex flex-col gap-2 px-5 py-3 border-t border-[var(--border)]">
            {error && (
              <div className="text-xs text-red-400 bg-red-900/20 px-3 py-2 rounded-lg">{error}</div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border-strong)] hover:bg-[var(--surface-3)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSubmitting || !name.trim() || taskList.length === 0}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[var(--accent-600)] text-white hover:bg-[var(--accent-500)] transition-colors disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : '💾 Save Template'}
            </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
