import {
  AlertTriangle,
  BatteryLow,
  Brain,
  CirclePause,
  Eye,
  Pause,
  Search,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import type { MicroStatus } from '@/types';
import { cn } from '@/lib/utils';

const MICRO_STATUS_ICONS: Record<MicroStatus, LucideIcon> = {
  waiting_on_someone: Pause,
  need_to_think: Brain,
  started_but_stuck: AlertTriangle,
  ready_but_unmotivated: BatteryLow,
  done_needs_review: Eye,
  blocked_external: ShieldAlert,
  in_research: Search,
  on_hold: CirclePause,
};

export function MicroStatusIcon({
  status,
  size = 14,
  className,
  style,
}: {
  status: MicroStatus;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const Icon = MICRO_STATUS_ICONS[status];

  return (
    <Icon
      size={size}
      className={cn('shrink-0', className)}
      fill={status === 'waiting_on_someone' ? 'currentColor' : undefined}
      style={style}
      data-micro-status-icon={status}
      aria-hidden="true"
    />
  );
}
