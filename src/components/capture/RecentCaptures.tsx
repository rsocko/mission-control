'use client';

import { useState, useEffect, useCallback } from 'react';
import { Clock, ArrowRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface CapturedItem {
  id: string;
  title: string;
  createdAt: string;
  status: string;
}

interface RecentCapturesProps {
  refreshKey?: number;
  onSelectTask: (taskId: string) => void;
}

export function RecentCaptures({ refreshKey, onSelectTask }: RecentCapturesProps) {
  const [items, setItems] = useState<CapturedItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRecent = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?sortBy=createdAt&sortDirection=desc&limit=10&status=todo');
      if (!res.ok) return;
      const data = await res.json();
      const taskList = data.tasks || data;
      if (Array.isArray(taskList)) {
        setItems(taskList.slice(0, 10).map((t: Record<string, unknown>) => ({
          id: t.id as string,
          title: t.title as string,
          createdAt: t.createdAt as string,
          status: t.status as string,
        })));
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecent();
  }, [fetchRecent, refreshKey]);

  // Listen for new captures
  useEffect(() => {
    const handler = () => fetchRecent();
    window.addEventListener('mission-control:task-added', handler);
    return () => window.removeEventListener('mission-control:task-added', handler);
  }, [fetchRecent]);

  if (loading || items.length === 0) return null;

  return (
    <div className="mt-6">
      <h2 className="text-xs font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Clock size={12} />
        Recent Captures
      </h2>
      <ul className="space-y-1">
        {items.map(item => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelectTask(item.id)}
              className="group flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span className="text-sm text-[var(--text-primary)] truncate flex-1">
                {item.title}
              </span>
              <span className="text-[10px] text-[var(--text-tertiary)] whitespace-nowrap">
                {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
              </span>
              <ArrowRight
                size={14}
                aria-hidden="true"
                className="shrink-0 text-[var(--text-tertiary)] transition-transform group-hover:translate-x-0.5"
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
