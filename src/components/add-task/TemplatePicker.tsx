'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Search, FileText } from 'lucide-react';
import { dropdownVariants } from '@/lib/motion';
import type { TaskTemplate, TemplateCategory, TemplateType } from '@/types';
import { TEMPLATE_CATEGORY_CONFIG } from '@/types';
import { taskLogger } from '@/lib/client-logger';

interface TemplatePickerProps {
  open: boolean;
  onClose: () => void;
  onSelectSingle: (template: TaskTemplate) => void;
  onSelectWorkflow: (template: TaskTemplate) => void;
  /** Anchor position relative to parent — picker positions itself absolutely */
  anchor?: 'left' | 'right';
}

const ALL_CATEGORIES: Array<{ key: TemplateCategory | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  ...Object.entries(TEMPLATE_CATEGORY_CONFIG).map(([key, cfg]) => ({
    key: key as TemplateCategory,
    label: `${cfg.emoji} ${cfg.label}`,
  })),
];

export function TemplatePicker({
  open,
  onClose,
  onSelectSingle,
  onSelectWorkflow,
  anchor = 'left',
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [navIndex, setNavIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load templates on first open
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch('/api/subtask-templates', { signal: controller.signal })
      .then(r => r.json())
      .then(data => setTemplates(data.templates || []))
      .catch((err) => { if (err?.name !== 'AbortError') taskLogger.error('Failed to fetch subtask templates', { err }); });
    return () => controller.abort();
  }, [open]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setSearch('');
      setCategory('all');
      setNavIndex(0);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  // Filter templates
  const filtered = useMemo(() => {
    let list = templates;
    if (category !== 'all') {
      list = list.filter(t => t.category === category);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
      );
    }
    return list;
  }, [templates, search, category]);

  // Clamp nav index
  useEffect(() => {
    setNavIndex(i => Math.min(i, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  // Scroll active item into view
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const item = container.querySelector(`[data-tmpl-idx="${navIndex}"]`);
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [navIndex]);

  const handleSelect = useCallback((template: TaskTemplate) => {
    const tplType: TemplateType = (template.type as TemplateType) || 'single';
    if (tplType === 'workflow') {
      onSelectWorkflow(template);
    } else {
      onSelectSingle(template);
    }
    onClose();
  }, [onSelectSingle, onSelectWorkflow, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (filtered.length === 0) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setNavIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setNavIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[navIndex]) handleSelect(filtered[navIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [filtered, navIndex, handleSelect, onClose]);

  // Close on outside click
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={containerRef}
          className={`absolute ${anchor === 'right' ? 'right-0' : 'left-0'} top-full z-50 mt-1.5 flex w-[360px] flex-col overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-1)] shadow-[0_20px_60px_rgba(0,0,0,0.5)]`}
          variants={dropdownVariants}
          initial="hidden"
          animate="show"
          exit="exit"
          onKeyDown={handleKeyDown}
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-[var(--border)]">
            <Search size={13} className="text-[var(--text-muted)] flex-shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); setNavIndex(0); }}
              placeholder="Search templates…"
              className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
            />
          </div>

          {/* Category tabs */}
          <div className="flex gap-1 px-3 py-2 overflow-x-auto border-b border-[var(--border-subtle)]">
            {ALL_CATEGORIES.map(cat => (
              <button
                key={cat.key}
                onClick={() => { setCategory(cat.key); setNavIndex(0); }}
                className={`text-xs px-2.5 py-1 rounded-md whitespace-nowrap transition-colors ${
                  category === cat.key
                    ? 'bg-[var(--accent-900)] text-[var(--accent-400)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Template list */}
          <div ref={scrollRef} className="max-h-[280px] overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-xs text-[var(--text-muted)] text-center">
                No templates found
              </div>
            )}
            {filtered.map((tmpl, i) => {
              const isActive = i === navIndex;
              const tplType: TemplateType = (tmpl.type as TemplateType) || 'single';
              const stepCount = tplType === 'workflow'
                ? tmpl.workflowTasks?.length || 0
                : tmpl.subtasks.length;
              const totalMinutes = tmpl.subtasks.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);

              return (
                <button
                  key={tmpl.id}
                  data-tmpl-idx={i}
                  onClick={() => handleSelect(tmpl)}
                  onMouseEnter={() => setNavIndex(i)}
                  className={`w-full flex items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors border-b border-[var(--border-subtle)] last:border-b-0 ${
                    isActive ? 'bg-[var(--surface-0)]' : 'hover:bg-[var(--surface-0)]'
                  }`}
                >
                  <span className="text-base mt-0.5 flex-shrink-0">{tmpl.icon || '📄'}</span>
                  <div className="flex-1 min-w-0">
                    <span className="block text-xs font-semibold text-[var(--text-primary)] truncate">{tmpl.name}</span>
                    <span className="block text-xs text-[var(--text-muted)] truncate mt-0.5">{tmpl.description || `${stepCount} steps`}</span>
                    <div className="flex gap-1.5 mt-1">
                      {tplType === 'workflow' ? (
                        <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300">
                          Workflow · {stepCount} tasks
                        </span>
                      ) : (
                        <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300">
                          Single
                        </span>
                      )}
                      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-muted)]">
                        {stepCount} steps{totalMinutes > 0 ? ` · ~${totalMinutes}min` : ''}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="border-t border-[var(--border)] px-3.5 py-2 flex justify-between items-center">
            <span className="text-xs text-[var(--text-muted)]">↑↓ navigate · Enter select · Esc close</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
