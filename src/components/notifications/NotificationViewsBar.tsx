'use client';

import { useEffect, useState } from 'react';
import { BookmarkPlus, X } from 'lucide-react';
import type { NotificationQuery } from '@/lib/notifications/query';
import {
  hasActiveNotificationFilters,
  notificationQueriesEqual,
} from '@/lib/notifications/query';
import type { NotificationView } from '@/lib/notifications/views';
import { cn } from '@/lib/utils';

interface NotificationViewsBarProps {
  query: NotificationQuery;
  activeViewId: string | null;
  onApply: (view: NotificationView) => void;
  onAnnouncement: (message: string) => void;
  variant?: 'bar' | 'sidebar';
}

export function NotificationViewsBar({
  query,
  activeViewId,
  onApply,
  onAnnouncement,
  variant = 'bar',
}: NotificationViewsBarProps) {
  const [views, setViews] = useState<NotificationView[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [viewsLoaded, setViewsLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/notifications/views', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        setViews(data.views ?? []);
        setViewsLoaded(true);
      })
      .catch(error => {
        if (error instanceof Error && error.name === 'AbortError') return;
        onAnnouncement('Saved views are unavailable.');
      });
    return () => controller.abort();
  }, [onAnnouncement]);

  async function saveView(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const response = await fetch('/api/notifications/views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, query }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setViews(current => [...current, data.view]);
      setName('');
      setShowSave(false);
      onAnnouncement(`Saved view ${trimmed}.`);
    } catch {
      onAnnouncement(`Could not save view ${trimmed}.`);
    } finally {
      setSaving(false);
    }
  }

  async function deleteView(view: NotificationView) {
    try {
      const response = await fetch(`/api/notifications/views/${encodeURIComponent(view.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        onAnnouncement(`Could not delete view ${view.name}.`);
        return;
      }
      setViews(current => current.filter(candidate => candidate.id !== view.id));
      onAnnouncement(`Deleted view ${view.name}.`);
    } catch {
      onAnnouncement(`Could not delete view ${view.name}.`);
    }
  }

  const canSave = viewsLoaded
    && hasActiveNotificationFilters(query)
    && !views.some(view => notificationQueriesEqual(query, view.query));

  if (variant === 'sidebar') {
    return (
      <nav aria-label="Saved notification views" className="mb-4">
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          Saved views
        </div>
        <div className="space-y-0.5">
          {views.map(view => {
            const active = activeViewId === view.id && notificationQueriesEqual(query, view.query);
            return (
              <div key={view.id} className="group flex items-center">
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onApply(view)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium',
                    active
                      ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                  )}
                >
                  <BookmarkPlus size={14} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{view.name}</span>
                </button>
                {!view.builtIn && (
                  <button
                    type="button"
                    aria-label={`Delete saved view ${view.name}`}
                    onClick={() => void deleteView(view)}
                    className="rounded p-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:text-red-300 focus:opacity-100 group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
          {canSave && !showSave && (
            <button
              type="button"
              onClick={() => setShowSave(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-[var(--accent)] hover:bg-[var(--surface-2)]"
            >
              <BookmarkPlus size={14} aria-hidden="true" />
              Save current view
            </button>
          )}
          {showSave && (
            <form onSubmit={saveView} className="space-y-1.5 rounded-md bg-[var(--surface-2)] p-2">
              <label htmlFor="saved-view-name" className="text-xs font-medium text-[var(--text-secondary)]">
                View name
              </label>
              <input
                id="saved-view-name"
                autoFocus
                value={name}
                maxLength={80}
                onChange={event => setName(event.target.value)}
                className="h-8 w-full rounded border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={saving || !name.trim()}
                  className="text-xs font-medium text-[var(--accent)] disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setShowSave(false)}
                  className="text-xs text-[var(--text-muted)]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Saved notification views" className="flex items-center gap-1 overflow-x-auto pb-1">
      {views.map(view => {
        const active = activeViewId === view.id && notificationQueriesEqual(query, view.query);
        return (
          <span key={view.id} className="inline-flex shrink-0 items-center">
            <button
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onApply(view)}
              className={`rounded-md px-2 py-1 text-xs ${
                active
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {view.name}
            </button>
            {!view.builtIn && (
              <button
                type="button"
                aria-label={`Delete saved view ${view.name}`}
                onClick={() => void deleteView(view)}
                className="-ml-1 rounded p-1 text-[var(--text-muted)] hover:text-red-300"
              >
                <X size={10} />
              </button>
            )}
          </span>
        );
      })}
      {showSave ? (
        <form onSubmit={saveView} className="flex shrink-0 items-center gap-1">
          <label htmlFor="saved-view-name" className="sr-only">View name</label>
          <input
            id="saved-view-name"
            autoFocus
            value={name}
            maxLength={80}
            onChange={event => setName(event.target.value)}
            className="h-7 w-36 rounded border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs"
          />
          <button type="submit" disabled={saving || !name.trim()} className="text-xs text-[var(--accent)]">
            Save
          </button>
          <button type="button" onClick={() => setShowSave(false)} className="text-xs text-[var(--text-muted)]">
            Cancel
          </button>
        </form>
      ) : canSave ? (
        <button
          type="button"
          onClick={() => setShowSave(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <BookmarkPlus size={12} />
          Save view
        </button>
      ) : null}
    </nav>
  );
}
