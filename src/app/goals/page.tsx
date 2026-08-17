'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import {
  DevelopPanel, GoalsContent, GoalsFilterChips, GoalsSidebar,
  type DevelopProposal, type FilterType, type GoalItem, type GoalType,
} from '@/components/goals';
import { useQuickAddContext } from '@/lib/hooks/useQuickAddContext';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

const MobileGoalsPage = dynamic(
  () => import('@/components/goals/MobileGoalsPage').then(mod => mod.MobileGoalsPage),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-4 animate-pulse px-4 pt-4">
        <div className="h-8 w-32 rounded-lg bg-[var(--surface-2)]" />
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-8 w-20 rounded-full bg-[var(--surface-1)] border border-[var(--border)]" />
          ))}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-[var(--surface-1)] border border-[var(--border)]" />
          ))}
        </div>
      </div>
    ),
  },
);

export default function GoalsPage() {
  const isMobile = useIsMobile();

  // On mobile, render the dedicated mobile goals view
  if (isMobile) {
    return <MobileGoalsPage />;
  }

  return <DesktopGoalsPage />;
}

function DesktopGoalsPage() {
  const [items, setItems] = useState<GoalItem[]>([]);
  const [counts, setCounts] = useState({ goal: 0, idea: 0, brainstorm: 0 });
  const [filter, setFilter] = useState<FilterType>('all');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [developingId, setDevelopingId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<DevelopProposal | null>(null);
  const [proposalTaskId, setProposalTaskId] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const { setQuickAddFilter, clearQuickAddFilter } = useQuickAddContext();

  const fetchGoals = useCallback(async () => {
    try {
      const params = new URLSearchParams({ filter });
      if (projectFilter) params.set('project', projectFilter);
      const res = await fetch(`/api/goals?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setItems(data.items || []);
      setCounts(data.counts || { goal: 0, idea: 0, brainstorm: 0 });
    } catch (err) {
      toast.error('Failed to load goals');
    } finally {
      setLoading(false);
    }
  }, [filter, projectFilter]);

  useEffect(() => {
    setLoading(true);
    fetchGoals();
  }, [fetchGoals]);

  useEffect(() => {
    const tag = filter === 'all' ? 'idea' : filter;
    const placeholders: Record<string, string> = {
      all: 'Quick capture — type an idea, goal, or brainstorm...',
      goal: 'Add a new goal...',
      idea: 'Capture a new idea...',
      brainstorm: 'Add a brainstorm...',
    };
    setQuickAddFilter({
      defaultTags: [tag],
      placeholderOverride: placeholders[filter] || placeholders.all,
    });
    return () => clearQuickAddFilter();
  }, [filter, setQuickAddFilter, clearQuickAddFilter]);

  useEffect(() => {
    const handler = () => fetchGoals();
    window.addEventListener('mission-control:task-added', handler);
    return () => window.removeEventListener('mission-control:task-added', handler);
  }, [fetchGoals]);

  const grouped = useMemo(() => {
    if (filter !== 'all') return { [filter]: items };
    return items.reduce((acc, item) => {
      if (!acc[item.goalType]) acc[item.goalType] = [];
      acc[item.goalType].push(item);
      return acc;
    }, {} as Record<GoalType, GoalItem[]>);
  }, [items, filter]);

  const projectCounts = useMemo(() => {
    const map = new Map<string, { project: GoalItem['linkedProjects'][0]; count: number }>();
    for (const item of items) {
      for (const proj of item.linkedProjects) {
        const existing = map.get(proj.id);
        if (existing) {
          existing.count++;
        } else {
          map.set(proj.id, { project: proj, count: 1 });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [items]);

  const handleDevelop = async (taskId: string) => {
    setDevelopingId(taskId);
    setProposal(null);
    setProposalTaskId(taskId);
    try {
      const res = await fetch('/api/goals/develop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'AI request failed');
      }
      const data = await res.json();
      setProposal(data.proposal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to develop idea';
      toast.error(message);
      setProposalTaskId(null);
    } finally {
      setDevelopingId(null);
    }
  };

  const handlePromote = async () => {
    if (!proposal?.suggestedProject || !proposalTaskId) return;
    setPromoting(true);
    try {
      const phases = proposal.suggestedProject.phases.map(phase => ({
        name: phase.name,
        description: phase.description,
        tasks: phase.taskIndices
          .map(idx => proposal.suggestedTasks[idx])
          .filter(Boolean)
          .map(t => ({ title: t.title, description: t.description })),
      }));
      const res = await fetch('/api/goals/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: proposalTaskId,
          projectName: proposal.suggestedProject.name,
          projectDescription: proposal.suggestedProject.description,
          category: proposal.suggestedProject.category,
          phases,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Promotion failed');
      }
      const data = await res.json();
      toast.success(`Created project "${proposal.suggestedProject.name}" with ${data.tasksCreated} tasks`);
      setProposal(null);
      setProposalTaskId(null);
      fetchGoals();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create project';
      toast.error(message);
    } finally {
      setPromoting(false);
    }
  };

  const totalCount = counts.goal + counts.idea + counts.brainstorm;
  const selectedItem = items.find(item => item.id === proposalTaskId) || null;
  const closeProposal = () => {
    setProposalTaskId(null);
    setProposal(null);
  };

  return (
    <div className="flex h-full">
      <GoalsSidebar filter={filter} counts={counts} totalCount={totalCount} onFilterChange={setFilter} projectFilter={projectFilter} onProjectFilterChange={setProjectFilter} projectCounts={projectCounts} />
      <main className="flex-1 overflow-y-auto">
        <div className="bg-[var(--surface-0)] border-b border-[var(--border-subtle)] px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-[var(--text-primary)] tracking-tight">Goals & Ideas</h2>
            <GoalsFilterChips filter={filter} counts={counts} totalCount={totalCount} onFilterChange={setFilter} />
          </div>
        </div>
        <div className="p-6 space-y-8">
          <GoalsContent loading={loading} items={items} filter={filter} grouped={grouped} developingId={developingId} onDevelop={handleDevelop} />
        </div>
      </main>
      <AnimatePresence>
        {proposalTaskId && (
          <motion.aside
            className="w-80 bg-[var(--surface-1)] border-l border-[var(--border)] overflow-y-auto flex-shrink-0 flex flex-col"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            <DevelopPanel
              item={selectedItem}
              proposal={proposal}
              loading={developingId !== null}
              promoting={promoting}
              onPromote={handlePromote}
              onClose={closeProposal}
            />
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
