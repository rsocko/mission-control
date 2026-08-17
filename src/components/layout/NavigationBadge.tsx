import { cn } from '@/lib/utils';
import type { NavBadgeTone } from '@/lib/navigation/badges';

const TONE_CLASSES: Record<NavBadgeTone, string> = {
  red: 'bg-red-500 text-white',
  amber: 'bg-amber-400 text-amber-950',
  blue: 'bg-blue-500 text-white',
};

export function NavigationBadge({
  count,
  tone,
  overlay = false,
}: {
  count: number;
  tone: NavBadgeTone;
  overlay?: boolean;
}) {
  if (count <= 0) return null;

  return (
    <span
      className={cn(
        'flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-bold leading-none tabular-nums',
        TONE_CLASSES[tone],
        overlay && 'absolute -right-2.5 -top-2',
      )}
      aria-label={`${count} items need attention`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
