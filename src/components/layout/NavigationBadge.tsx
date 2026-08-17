import { cn } from '@/lib/utils';
import type { NavBadgeTone } from '@/lib/navigation/badges';

const TONE_CLASSES: Record<NavBadgeTone, string> = {
  red: 'bg-red-500 text-white',
  amber: 'bg-amber-400 text-amber-950',
  blue: 'bg-blue-500 text-white',
};

const PRESSURE_TONE_CLASSES: Record<NavBadgeTone, string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-400',
  blue: 'bg-blue-500',
};

function getPressureLevel(count: number) {
  if (count >= 50) return 'high';
  if (count >= 10) return 'medium';
  return 'low';
}

const PRESSURE_WIDTH_CLASSES = {
  low: 'w-2',
  medium: 'w-4',
  high: 'w-[30px]',
} as const;

export function NavigationPressureBar({
  count,
  tone,
  pulse = false,
}: {
  count: number;
  tone: NavBadgeTone;
  pulse?: boolean;
}) {
  if (count <= 0) return null;

  const level = getPressureLevel(count);

  return (
    <span
      className={cn(
        'absolute -bottom-1.5 left-1/2 h-[3px] -translate-x-1/2 rounded-full',
        PRESSURE_TONE_CLASSES[tone],
        PRESSURE_WIDTH_CLASSES[level],
        pulse && 'motion-safe:animate-pulse',
      )}
      data-testid="navigation-pressure-bar"
      data-pressure-level={level}
      aria-label={`${count} items need attention`}
    />
  );
}

export function NavigationBadge({
  count,
  tone,
  overlay = false,
  pulse = false,
}: {
  count: number;
  tone: NavBadgeTone;
  overlay?: boolean;
  pulse?: boolean;
}) {
  if (count <= 0) return null;

  return (
    <span
      className={cn(
        'flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-bold leading-none tabular-nums',
        TONE_CLASSES[tone],
        overlay && 'absolute -right-2.5 -top-2',
        pulse && 'motion-safe:animate-pulse',
      )}
      aria-label={`${count} items need attention`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
