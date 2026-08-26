'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';
import { Globe } from 'lucide-react';
import { SubtaskPill } from '@/components/ui/SubtaskPill';
import { MICRO_STATUS_CONFIG } from '@/types';
import type { MicroStatus } from '@/types';
import { CONNECTOR_ICONS } from '@/types/dashboard';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { cn } from '@/lib/utils';
import { MicroStatusIcon } from './MicroStatusIcon';
import { TaskBlockedBadge, isTaskBlocked } from './TaskStatusIndicator';

export interface TaskRowIdentityTask {
  title: string;
  status: string;
  connectorType: string;
  metadata?: string | null;
  sourceId?: string | null;
  microStatus?: string | null;
  subtaskDone?: number | null;
  subtaskTotal?: number | null;
}

interface TaskRowIdentityProps {
  task: TaskRowIdentityTask;
  isDone?: boolean;
  compact?: boolean;
  beforeTitle?: ReactNode;
  afterConnector?: ReactNode;
  afterTitle?: ReactNode;
  secondary?: ReactNode;
  onOpenSubtasks?: () => void;
  showMicroStatusLabel?: boolean;
  showSubtasks?: boolean;
}

export function TaskRowIdentity({
  task,
  isDone = false,
  compact = false,
  beforeTitle,
  afterConnector,
  afterTitle,
  secondary,
  onOpenSubtasks,
  showMicroStatusLabel = true,
  showSubtasks = true,
}: TaskRowIdentityProps) {
  const displayId = getTaskDisplayId(task.connectorType, task.metadata, task.sourceId);
  const microStatus = task.microStatus as MicroStatus | null | undefined;
  const microStatusConfig = microStatus ? MICRO_STATUS_CONFIG[microStatus] : null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {beforeTitle}
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center"
        title={task.connectorType}
      >
        {CONNECTOR_ICONS[task.connectorType] ? (
          <Image
            src={CONNECTOR_ICONS[task.connectorType]}
            alt={task.connectorType}
            width={compact ? 12 : 14}
            height={compact ? 12 : 14}
          />
        ) : (
          <Globe size={compact ? 12 : 14} className="text-[var(--text-muted)]" />
        )}
      </span>
      {afterConnector}

      <div className="min-w-0 flex-1">
        <div className={cn('flex min-w-0 items-center', compact ? 'gap-1.5' : 'gap-2')}>
          <span
            className={cn(
              'truncate font-medium',
              compact ? 'text-xs text-[var(--text-secondary)]' : 'text-sm text-[var(--text-primary)]',
              isDone && 'line-through text-[var(--text-muted)]',
            )}
          >
            {task.title}
          </span>
          {displayId ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-muted)]">
              {displayId}
            </span>
          ) : null}
          {microStatus && isTaskBlocked(task.status, microStatus) ? (
            <TaskBlockedBadge
              status={task.status}
              microStatus={microStatus}
              className={showMicroStatusLabel ? 'hidden @md:inline-flex' : undefined}
            />
          ) : showMicroStatusLabel && microStatus && microStatusConfig ? (
            <span
              className="hidden shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs font-medium @md:inline-flex"
              style={{
                backgroundColor: `${microStatusConfig.color}20`,
                color: microStatusConfig.color,
              }}
              title={microStatusConfig.description}
            >
              <MicroStatusIcon status={microStatus} size={11} />
              {microStatusConfig.label}
            </span>
          ) : null}
          {showSubtasks ? (
            <SubtaskPill
              done={task.subtaskDone ?? 0}
              total={task.subtaskTotal ?? 0}
              onClick={onOpenSubtasks}
            />
          ) : null}
          {afterTitle}
        </div>
        {secondary ? (
          <div className="min-w-0 overflow-hidden">{secondary}</div>
        ) : null}
      </div>
    </div>
  );
}
