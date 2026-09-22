import { cn } from '@/lib/utils';
import type { NavBadgeTone } from '@/lib/navigation/badges';
import { motion, useReducedMotion, type Transition } from 'motion/react';

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

const MORPH_TRANSITION: Transition = {
  duration: 0.38,
  ease: [0.32, 0.72, 0, 1],
};

const LABEL_FADE_TRANSITION: Transition = { duration: 0.12 };

/**
 * Geometry of the nav row, in pixels. The morph animates between two explicit
 * frames measured from the row itself, so it never depends on sibling badges.
 */
const RAIL_ROW_HEIGHT = 40;
const RAIL_ROW_PADDING_X = 10;
const RAIL_ICON_WIDTH = 22;
const RAIL_EXPANDED_ROW_WIDTH = 184;

const BAR_HEIGHT = 3;
const BADGE_HEIGHT = 20;

/** Both frames share a bottom edge so the morph grows upward, never sideways. */
const BAR_BOTTOM_OFFSET = RAIL_ROW_HEIGHT - 37;
const BADGE_BOTTOM_OFFSET = RAIL_ROW_HEIGHT - 30;

const BAR_WIDTHS = { low: 8, medium: 16, high: 30 } as const;
const BADGE_WIDTHS = { low: 20, medium: 24, high: 30 } as const;

/**
 * Single persistent element that animates between the collapsed underline and
 * the expanded badge.
 *
 * The rail previously crossfaded two separate elements via a shared `layoutId`.
 * That handoff measured the *first* mounted badge before the rail's width
 * transition had been applied, so whichever badge came first in DOM order (My
 * Day) started its morph from a stale, higher frame and appeared to travel up
 * before moving across. Keeping one element mounted and animating explicit
 * geometry removes the measurement entirely, so every row morphs identically.
 */
export function NavigationRailMorph({
  count,
  tone,
  expanded,
  expandedEndOffset = 0,
  pulse = false,
  morphId,
}: {
  count: number;
  tone: NavBadgeTone;
  expanded: boolean;
  expandedEndOffset?: number;
  pulse?: boolean;
  morphId?: string;
}) {
  const shouldReduceMotion = useReducedMotion();

  if (count <= 0) return null;

  const level = getPressureLevel(count);
  const label = count > 99 ? '99+' : String(count);

  const width = expanded ? BADGE_WIDTHS[level] : BAR_WIDTHS[level];
  const height = expanded ? BADGE_HEIGHT : BAR_HEIGHT;
  const bottomOffset = expanded ? BADGE_BOTTOM_OFFSET : BAR_BOTTOM_OFFSET;
  const targetLeft = expanded
    ? RAIL_EXPANDED_ROW_WIDTH - RAIL_ROW_PADDING_X - expandedEndOffset - width
    : RAIL_ROW_PADDING_X + RAIL_ICON_WIDTH / 2 - width / 2;

  return (
    <motion.span
      className={cn(
        'pointer-events-none absolute left-0 flex items-center justify-center rounded-full text-xs font-bold leading-none tabular-nums',
        expanded ? TONE_CLASSES[tone] : PRESSURE_TONE_CLASSES[tone],
        pulse && 'motion-safe:animate-pulse',
      )}
      style={{ bottom: BAR_BOTTOM_OFFSET }}
      initial={false}
      animate={{
        x: targetLeft,
        y: -(bottomOffset - BAR_BOTTOM_OFFSET),
        width,
        height,
      }}
      transition={shouldReduceMotion ? { duration: 0 } : MORPH_TRANSITION}
      data-morph-id={morphId}
      data-morph-state={expanded ? 'badge' : 'bar'}
      data-testid="navigation-rail-morph"
      data-pressure-level={level}
      aria-label={`${count} items need attention`}
    >
      <motion.span
        aria-hidden={!expanded}
        initial={false}
        animate={{ opacity: expanded ? 1 : 0 }}
        transition={shouldReduceMotion ? { duration: 0 } : LABEL_FADE_TRANSITION}
      >
        {label}
      </motion.span>
    </motion.span>
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
