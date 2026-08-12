'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TaskContextItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate?: string | null;
  project?: string | null;
}

interface TriageStatus {
  unreadCount: number;
  criticalCount: number;
  categories: string[];
}

interface HoustonContext {
  /** Tasks that are overdue */
  overdueTasks: TaskContextItem[];
  /** Tasks due today */
  todayTasks: TaskContextItem[];
  /** Tasks currently in progress */
  inProgressTasks: TaskContextItem[];
  /** Triage queue summary */
  triageStatus: TriageStatus;
  /** Whether context is still loading */
  isLoading: boolean;
  /** Formatted system context string for injection into AI API calls */
  systemContext: string;
  /** Manually refresh context */
  refresh: () => void;
}

const defaultTriageStatus: TriageStatus = { unreadCount: 0, criticalCount: 0, categories: [] };

const HoustonContextValue = createContext<HoustonContext>({
  overdueTasks: [],
  todayTasks: [],
  inProgressTasks: [],
  triageStatus: defaultTriageStatus,
  isLoading: true,
  systemContext: '',
  refresh: () => {},
});

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Access Houston's context-awareness data.
 * Provides overdue/today/in-progress tasks and triage queue status
 * for injection as system context into chat API calls.
 */
export function useHoustonContext() {
  return useContext(HoustonContextValue);
}

// ─── Provider ───────────────────────────────────────────────────────────────

export function HoustonContextProvider({ children }: { children: ReactNode }) {
  const [overdueTasks, setOverdueTasks] = useState<TaskContextItem[]>([]);
  const [todayTasks, setTodayTasks] = useState<TaskContextItem[]>([]);
  const [inProgressTasks, setInProgressTasks] = useState<TaskContextItem[]>([]);
  const [triageStatus, setTriageStatus] = useState<TriageStatus>(defaultTriageStatus);
  const [isLoading, setIsLoading] = useState(true);

  const fetchContext = useCallback(async () => {
    setIsLoading(true);
    try {
      const [tasksRes, alertsRes] = await Promise.all([
        fetch('/api/ai/context-tasks'),
        fetch('/api/ai/context-triage'),
      ]);

      if (tasksRes.ok) {
        const data = await tasksRes.json() as {
          overdue?: TaskContextItem[];
          today?: TaskContextItem[];
          inProgress?: TaskContextItem[];
        };
        setOverdueTasks(data.overdue || []);
        setTodayTasks(data.today || []);
        setInProgressTasks(data.inProgress || []);
      }

      if (alertsRes.ok) {
        const data = await alertsRes.json() as TriageStatus;
        setTriageStatus(data);
      }
    } catch {
      // Context fetch is best-effort; silent fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void fetchContext(); }, [fetchContext]);

  // Refresh every 2 minutes to stay current
  useEffect(() => {
    const interval = setInterval(() => void fetchContext(), 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchContext]);

  const systemContext = useMemo(() => {
    if (isLoading) return '';
    return buildSystemContext({ overdueTasks, todayTasks, inProgressTasks, triageStatus });
  }, [overdueTasks, todayTasks, inProgressTasks, triageStatus, isLoading]);

  const value = useMemo<HoustonContext>(() => ({
    overdueTasks,
    todayTasks,
    inProgressTasks,
    triageStatus,
    isLoading,
    systemContext,
    refresh: fetchContext,
  }), [overdueTasks, todayTasks, inProgressTasks, triageStatus, isLoading, systemContext, fetchContext]);

  return (
    <HoustonContextValue value={value}>
      {children}
    </HoustonContextValue>
  );
}

// ─── System Context Builder ─────────────────────────────────────────────────

function buildSystemContext({
  overdueTasks,
  todayTasks,
  inProgressTasks,
  triageStatus,
}: {
  overdueTasks: TaskContextItem[];
  todayTasks: TaskContextItem[];
  inProgressTasks: TaskContextItem[];
  triageStatus: TriageStatus;
}): string {
  const sections: string[] = [];

  if (overdueTasks.length > 0) {
    sections.push(
      `## Overdue Tasks (${overdueTasks.length})\n` +
      overdueTasks.slice(0, 5).map(t => `- "${t.title}" (${t.priority} priority, due ${t.dueDate || 'unknown'})`).join('\n'),
    );
  }

  if (todayTasks.length > 0) {
    sections.push(
      `## Due Today (${todayTasks.length})\n` +
      todayTasks.slice(0, 5).map(t => `- "${t.title}" (${t.priority} priority${t.project ? `, project: ${t.project}` : ''})`).join('\n'),
    );
  }

  if (inProgressTasks.length > 0) {
    sections.push(
      `## In Progress (${inProgressTasks.length})\n` +
      inProgressTasks.slice(0, 5).map(t => `- "${t.title}" (${t.priority} priority${t.project ? `, project: ${t.project}` : ''})`).join('\n'),
    );
  }

  if (triageStatus.unreadCount > 0) {
    sections.push(
      `## Triage Queue\n` +
      `- ${triageStatus.unreadCount} unread notifications\n` +
      `- ${triageStatus.criticalCount} critical items\n` +
      (triageStatus.categories.length > 0 ? `- Categories: ${triageStatus.categories.join(', ')}` : ''),
    );
  }

  if (sections.length === 0) return '';

  return `[CURRENT USER CONTEXT]\nThe user currently has the following task state:\n\n${sections.join('\n\n')}\n\nUse this context to give specific, actionable advice referencing tasks by name when relevant.`;
}
