'use client';

import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { NavBadgeTone } from '@/lib/navigation/badges';
import { motion, type Transition, useAnimationControls } from 'motion/react';

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

const PRESSURE_WIDTHS = {
  low: 8,
  medium: 16,
  high: 30,
} as const;

const RAIL_MORPH_TRANSITION: Transition = {
  duration: 0.36,
  times: [0, 0.58, 1],
  ease: [0.32, 0.72, 0, 1],
};

function getRailShapes(pressureWidth: number, badgeWidth: number) {
  const collapsedLeft = 21 - pressureWidth / 2;
  const collapsedLeftPx = `${collapsedLeft}px`;
  const pressureWidthPx = `${pressureWidth}px`;
  const badgeWidthPx = `${badgeWidth}px`;
  const collapsedTarget = {
    '--rail-left-percent': '0%',
    '--rail-left-offset': collapsedLeftPx,
    '--rail-width-percent': '0%',
    '--rail-width-offset': pressureWidthPx,
    top: '34px',
    height: '3px',
  };
  const expandedTarget = {
    '--rail-left-percent': '100%',
    '--rail-left-offset': `-${badgeWidth + 10}px`,
    '--rail-width-percent': '0%',
    '--rail-width-offset': badgeWidthPx,
    top: '10px',
    height: '20px',
  };

  return {
    collapsedTarget,
    expandedTarget,
    collapsedKeyframes: {
      '--rail-left-percent': ['100%', '0%', '0%'],
      '--rail-left-offset': [`-${badgeWidth + 10}px`, collapsedLeftPx, collapsedLeftPx],
      '--rail-width-percent': ['0%', '100%', '0%'],
      '--rail-width-offset': [badgeWidthPx, `-${collapsedLeft + 10}px`, pressureWidthPx],
      top: ['10px', '34px', '34px'],
      height: ['20px', '3px', '3px'],
    },
    expandedKeyframes: {
      '--rail-left-percent': ['0%', '0%', '100%'],
      '--rail-left-offset': [collapsedLeftPx, collapsedLeftPx, `-${badgeWidth + 10}px`],
      '--rail-width-percent': ['0%', '100%', '0%'],
      '--rail-width-offset': [pressureWidthPx, `-${collapsedLeft + 10}px`, badgeWidthPx],
      top: ['34px', '34px', '10px'],
      height: ['3px', '3px', '20px'],
    },
  };
}

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
    <motion.span
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
    <motion.span
      className={cn(
        'flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-bold leading-none tabular-nums',
        TONE_CLASSES[tone],
        overlay && 'absolute -right-2.5 -top-2',
        pulse && 'motion-safe:animate-pulse',
      )}
      aria-label={`${count} items need attention`}
    >
      {count > 99 ? '99+' : count}
    </motion.span>
  );
}

export function NavigationRailIndicator({
  count,
  tone,
  expanded,
  pulse = false,
}: {
  count: number;
  tone: NavBadgeTone;
  expanded: boolean;
  pulse?: boolean;
}) {
  const level = getPressureLevel(count);
  const pressureWidth = PRESSURE_WIDTHS[level];
  const badgeWidth = count > 99 ? 30 : count > 9 ? 24 : 20;
  const shapes = useMemo(
    () => getRailShapes(pressureWidth, badgeWidth),
    [pressureWidth, badgeWidth],
  );
  const controls = useAnimationControls();
  const previousExpanded = useRef(expanded);

  useEffect(() => {
    const target = expanded ? shapes.expandedTarget : shapes.collapsedTarget;

    if (previousExpanded.current === expanded) {
      controls.set(target);
      return;
    }

    previousExpanded.current = expanded;
    void controls.start(
      expanded ? shapes.expandedKeyframes : shapes.collapsedKeyframes,
    );
  }, [controls, expanded, shapes]);

  if (count <= 0) return null;

  return (
    <motion.span
      className={cn(
        'pointer-events-none absolute z-10 flex items-center justify-center overflow-hidden rounded-full text-xs font-bold leading-none tabular-nums',
        TONE_CLASSES[tone],
        pulse && 'motion-safe:animate-pulse',
      )}
      style={{
        left: 'calc(var(--rail-left-percent) + var(--rail-left-offset))',
        width: 'calc(var(--rail-width-percent) + var(--rail-width-offset))',
      }}
      initial={expanded ? shapes.expandedTarget : shapes.collapsedTarget}
      animate={controls}
      transition={RAIL_MORPH_TRANSITION}
      data-testid="navigation-rail-indicator"
      data-state={expanded ? 'expanded' : 'collapsed'}
      data-pressure-level={level}
      aria-label={`${count} items need attention`}
    >
      {expanded ? (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.24, duration: 0.1 }}
        >
          {count > 99 ? '99+' : count}
        </motion.span>
      ) : null}
    </motion.span>
  );
}
