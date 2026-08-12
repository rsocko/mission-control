'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, ExternalLink, Eye, Flag, List, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DuplicateCandidate {
  id: string;
  title: string;
  status: string;
  sourceId: string;
  connectorType: string;
  score: number;
  reasoning: string;
}

interface DuplicateTaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  sourceUrl: string | null;
}

interface DuplicateTaskPreviewProps {
  candidate: DuplicateCandidate;
}

const STATUS_LABELS: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const CONNECTOR_LABELS: Record<string, string> = {
  'github-issues': 'GitHub',
  'microsoft-todo': 'Microsoft To Do',
  'outlook-email': 'Outlook',
  'outlook-calendar': 'Outlook Calendar',
  local: 'Mission Control',
};

function formatDueDate(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(date);
}

export function DuplicateTaskPreview({ candidate }: DuplicateTaskPreviewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [detail, setDetail] = useState<DuplicateTaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const openedFromHover = useRef(false);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  const positionPreview = useCallback((contentHeight = 0) => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(352, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const top = contentHeight > spaceBelow && rect.top > spaceBelow
      ? Math.max(12, rect.top - contentHeight - 4)
      : rect.bottom + 4;
    setPosition({ top, left, width });
  }, []);

  const loadDetail = () => {
    if (detail || request.current) return;

    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    fetch(`/api/tasks/${candidate.id}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load task: ${response.status}`);
        return response.json();
      })
      .then((data: { task?: DuplicateTaskDetail }) => {
        if (!data.task) throw new Error('Task detail missing');
        setDetail(data.task);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          request.current = null;
          setLoading(false);
        }
      });
  };

  const openPreview = () => {
    cancelClose();
    positionPreview();
    setIsOpen(true);
    loadDetail();
  };

  const closePreview = () => {
    openedFromHover.current = false;
    setIsOpen(false);
  };

  const scheduleClose = () => {
    closeTimer.current = setTimeout(closePreview, 120);
  };

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      request.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => positionPreview(content.current?.offsetHeight ?? 0);
    const frame = window.requestAnimationFrame(updatePosition);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !content.current?.contains(target)) closePreview();
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [detail, isOpen, loading, positionPreview]);

  const openTask = () => {
    const event = new CustomEvent('mc:select-task', {
      cancelable: true,
      detail: { taskId: candidate.id },
    });
    const handled = !window.dispatchEvent(event);
    closePreview();
    if (!handled) window.location.assign(`/?taskId=${encodeURIComponent(candidate.id)}`);
  };

  const handleEscape = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    closePreview();
    trigger.current?.focus();
  };

  return (
    <div
      className="flex-1 min-w-0"
      onMouseEnter={() => {
        if (!isOpen) openedFromHover.current = true;
        openPreview();
      }}
      onMouseLeave={scheduleClose}
      onBlur={(event) => {
        if (!content.current?.contains(event.relatedTarget)) scheduleClose();
      }}
      onKeyDown={(event) => { if (event.key === 'Escape' && isOpen) handleEscape(event); }}
    >
      <button
        ref={trigger}
        type="button"
        onClick={(event) => {
          if (isOpen && openedFromHover.current) {
            openedFromHover.current = false;
            cancelClose();
          } else if (isOpen) {
            closePreview();
          } else {
            openPreview();
            if (event.detail === 0) {
              window.requestAnimationFrame(() => {
                content.current?.querySelector<HTMLElement>('button, a[href]')?.focus();
              });
            }
          }
        }}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls={isOpen ? `duplicate-preview-${candidate.id}` : undefined}
        className="group/preview w-full text-left rounded-md -m-1 p-1 hover:bg-purple-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--text-secondary)] truncate">{candidate.title}</span>
          <Eye size={12} className="flex-shrink-0 text-purple-400 opacity-0 group-hover/preview:opacity-100 group-focus-visible/preview:opacity-100 transition-opacity" />
        </span>
        <span className="text-xs text-[var(--text-muted)]">{Math.round(candidate.score * 100)}% similar - Preview</span>
      </button>

      {isOpen && position && createPortal(
        <div
          ref={content}
          id={`duplicate-preview-${candidate.id}`}
          role="dialog"
          aria-label={`Read-only preview of ${candidate.title}`}
          className="fixed z-[100] rounded-xl border border-purple-500/25 bg-[var(--surface-1)] p-3 shadow-2xl"
          style={position}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onFocus={cancelClose}
          onBlur={(event) => {
            if (!trigger.current?.contains(event.relatedTarget) && !event.currentTarget.contains(event.relatedTarget)) {
              scheduleClose();
            }
          }}
          onKeyDown={(event) => { if (event.key === 'Escape') handleEscape(event); }}
        >
          <div className="mb-2">
            <p className="text-sm font-semibold text-[var(--text-primary)] leading-snug">{detail?.title ?? candidate.title}</p>
            <p className="mt-1 text-xs text-purple-300">{candidate.reasoning}</p>
          </div>

          {loading && (
            <div className="flex items-center gap-2 py-4 text-xs text-[var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              Loading task details...
            </div>
          )}

          {error && (
            <p className="py-3 text-xs text-rose-400">Task details could not be loaded.</p>
          )}

          {detail && (
            <>
              {detail.description && (
                <p className="mb-3 max-h-24 overflow-hidden whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">
                  {detail.description}
                </p>
              )}
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-[var(--border-subtle)] pt-2 text-xs">
                <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                  <List size={12} />
                  <span className="truncate">{STATUS_LABELS[detail.status] ?? detail.status}</span>
                </div>
                <div className={cn('flex items-center gap-1.5', detail.priority === 'none' ? 'text-[var(--text-muted)]' : 'text-amber-300')}>
                  <Flag size={12} />
                  <span className="capitalize">{detail.priority || 'None'}</span>
                </div>
                {detail.dueDate && (
                  <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                    <Calendar size={12} />
                    <span>{formatDueDate(detail.dueDate)}</span>
                  </div>
                )}
                <div className="truncate text-[var(--text-muted)]">
                  {detail.sourceListName || CONNECTOR_LABELS[detail.connectorType] || detail.connectorType}
                </div>
              </div>
            </>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-2">
            <button
              type="button"
              onClick={openTask}
              className="inline-flex items-center gap-1.5 rounded-md bg-purple-500/15 px-2 py-1 text-xs font-medium text-purple-300 hover:bg-purple-500/25 transition-colors"
            >
              Open task
            </button>
            <a
              href={`/?taskId=${encodeURIComponent(candidate.id)}`}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              Permalink
            </a>
            {detail?.sourceUrl && (
              <a
                href={detail.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Open in {CONNECTOR_LABELS[detail.connectorType] || 'source'}
                <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
