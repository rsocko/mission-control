'use client';

import Image from 'next/image';
import { motion } from 'motion/react';
import { MapPin, AlertTriangle, Calendar, Clock, Repeat } from 'lucide-react';
import { getTagPillStyle } from '@/lib/constants/colors';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { kanbanCard } from '@/lib/motion';
import { SubtaskPill } from '@/components/ui/SubtaskPill';
import { CONNECTOR_BRAND_ICONS, PRIORITY_DOTS, PRIORITY_LABELS } from './constants';
import { getLocalToday } from '@/lib/utils/client-date';
import { SmartScoreBadge } from '@/components/smart-score/SmartScoreBadge';
import { SnoozePopover } from './SnoozePopover';
import type { KanbanTaskViewModel } from './types';

function formatSnoozeLabel(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);
  if (date >= tomorrow && date < dayAfter) return 'tomorrow';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

interface KanbanCardProps {
  task: KanbanTaskViewModel;
  /** Props spread onto the card root to make it a drag handle (from @dnd-kit useSortable) */
  dragHandleProps?: Record<string, unknown>;
  onClick?: () => void;
  showSources: boolean;
  showDueDates: boolean;
  showScores?: boolean;
  onSnooze?: (taskId: string, until: string) => void;
}

export function KanbanCard({ task, dragHandleProps, onClick, showSources, showDueDates, showScores, onSnooze }: KanbanCardProps) {
  const today = getLocalToday();
  const isOverdue = task.dueDate && task.dueDate < today;
  const taskMeta = task.metadata ? (() => { try { return JSON.parse(task.metadata); } catch { return null; } })() : null;
  const recurrence = taskMeta?.recurrence;

  return (
    <motion.div
      onClick={onClick}
      className="cursor-grab rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-3 shadow-sm transition-[box-shadow] duration-150 ease-in-out hover:shadow-md active:cursor-grabbing group"
      variants={kanbanCard}
      whileHover={{ y: -2, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.97 }}
      {...dragHandleProps}
    >
      <div className="flex items-start gap-2">
        {task.priority !== 'none' && (
          <span className="flex items-center gap-1 flex-shrink-0 mt-1" aria-label={`Priority: ${task.priority}`}>
            <span className={`w-2 h-2 rounded-full ${PRIORITY_DOTS[task.priority]}`} aria-hidden="true" />
            <span className="text-[9px] font-semibold text-[var(--text-tertiary)]">{PRIORITY_LABELS[task.priority]}</span>
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-[var(--text-primary)] font-medium leading-tight">
              {task.title}
              {(() => {
                const displayId = getTaskDisplayId(
                  task.connectorType,
                  task.metadata,
                  task.sourceId,
                );
                return displayId ? (
                  <span className="text-xs text-[var(--text-muted)] font-mono tabular-nums ml-1.5">{displayId}</span>
                ) : null;
              })()}
            </p>
            <div className="flex items-center gap-1 flex-shrink-0">
              {showScores && task.smartScore != null && (
                <SmartScoreBadge score={task.smartScore} size="sm" />
              )}
              {onSnooze && (
                <SnoozePopover taskId={task.id} onSnooze={onSnooze} />
              )}
            </div>
          </div>
          <SubtaskPill done={task.subtaskDone ?? 0} total={task.subtaskTotal ?? 0} className="mt-1" />
          {(showSources || showDueDates || (task.snoozedUntil && new Date(task.snoozedUntil) > new Date())) && (
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {task.snoozedUntil && new Date(task.snoozedUntil) > new Date() && (
                <span className="text-[10px] flex items-center gap-0.5 text-amber-400">
                  <Clock size={9} /> snoozed until {formatSnoozeLabel(task.snoozedUntil)}
                </span>
              )}
              {showSources && (() => {
                const src = CONNECTOR_BRAND_ICONS[task.connectorType];
                if (src) {
                  return <Image src={src} alt={task.connectorType} width={12} height={12} className="shrink-0" />;
                }
                return <MapPin size={10} className="text-[var(--text-muted)]" />;
              })()}
              {showSources && task.sourceListName && (
                <span className="text-xs text-[var(--text-muted)] truncate max-w-[80px]">{task.sourceListName}</span>
              )}
              {showDueDates && task.dueDate && (
                <span className={`text-xs flex items-center gap-0.5 ${isOverdue ? 'text-red-400 font-medium' : 'text-[var(--text-muted)]'}`}>
                  {isOverdue ? <AlertTriangle size={9} /> : <Calendar size={9} />} {formatShortDate(task.dueDate)}
                </span>
              )}
              {recurrence && (
                <span className="text-xs flex items-center gap-0.5 text-blue-400" title={`Repeats: ${recurrence}`}>
                  <Repeat size={9} />
                </span>
              )}
            </div>
          )}
          {task.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {task.tags.slice(0, 3).map(tag => (
                <span key={tag.id} className="text-[9px] px-1.5 py-0 rounded-full"
                  style={getTagPillStyle(tag.color)}>
                  {tag.name}
                </span>
              ))}
              {task.tags.length > 3 && (
                <span className="text-[9px] text-[var(--text-muted)]">+{task.tags.length - 3}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function formatShortDate(dateStr: string): string {
  const datePart = dateStr.split('T')[0];
  const parts = datePart.split('-');
  if (parts.length < 3) return dateStr;
  const [y, m, day] = parts.map(Number);
  if (!y || !m || !day) return dateStr;
  const d = new Date(y, m - 1, day);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 0) return `${Math.abs(diffDays)}d ago`;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}