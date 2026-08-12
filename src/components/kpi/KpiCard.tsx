'use client';

import { motion } from 'motion/react';
import {
  ClipboardList, AlertTriangle, CalendarDays, Bell, Sun, Flame,
  CheckCircle2, RefreshCw, Zap, TrendingUp, Inbox,
} from 'lucide-react';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import { statCardVariants } from '@/lib/motion';
import type { KpiCardDefinition, KpiCardData } from '@/lib/kpi/registry';

const ICON_MAP: Record<string, React.ComponentType<{ size: number }>> = {
  ClipboardList, AlertTriangle, CalendarDays, Bell, Sun, Flame,
  CheckCircle2, RefreshCw, Zap, TrendingUp, Inbox,
};

const ACCENT_CLASSES: Record<string, { border: string; value: string; icon: string; bar: string; dot: string }> = {
  blue: {
    border: 'border-[var(--border)]',
    value: 'text-[var(--accent-400)]',
    icon: 'text-[var(--accent-400)] bg-[var(--accent-900)]/20',
    bar: 'bg-[var(--accent-400)]',
    dot: 'bg-[var(--accent-400)]',
  },
  red: {
    border: 'border-red-800/40',
    value: 'text-red-400',
    icon: 'text-red-400 bg-red-900/20',
    bar: 'bg-red-400',
    dot: 'bg-red-400',
  },
  orange: {
    border: 'border-orange-800/40',
    value: 'text-orange-400',
    icon: 'text-orange-400 bg-orange-900/20',
    bar: 'bg-orange-400',
    dot: 'bg-orange-400',
  },
  amber: {
    border: 'border-amber-800/40',
    value: 'text-amber-400',
    icon: 'text-amber-400 bg-amber-900/20',
    bar: 'bg-amber-400',
    dot: 'bg-amber-400',
  },
  green: {
    border: 'border-green-800/40',
    value: 'text-green-400',
    icon: 'text-green-400 bg-green-900/20',
    bar: 'bg-green-400',
    dot: 'bg-green-400',
  },
  cyan: {
    border: 'border-cyan-800/40',
    value: 'text-cyan-400',
    icon: 'text-cyan-400 bg-cyan-900/20',
    bar: 'bg-cyan-400',
    dot: 'bg-cyan-400',
  },
  purple: {
    border: 'border-purple-800/40',
    value: 'text-purple-400',
    icon: 'text-purple-400 bg-purple-900/20',
    bar: 'bg-purple-400',
    dot: 'bg-purple-400',
  },
};

const DEFAULT_ACCENT = {
  border: 'border-[var(--border)]',
  value: 'text-[var(--text-primary)]',
  icon: 'text-[var(--text-tertiary)] bg-[var(--surface-0)]',
  bar: 'bg-[var(--text-tertiary)]',
  dot: 'bg-[var(--text-tertiary)]',
};

function getAccent(accentKey: string | undefined, value?: number) {
  if (!accentKey) return DEFAULT_ACCENT;
  // For counter types, dim accent when value is 0
  return ACCENT_CLASSES[accentKey] || DEFAULT_ACCENT;
}

// ─── Progress Bar ───────────────────────────────────────────────────────────

function ProgressBar({ value, max, accentClasses }: { value: number; max: number; accentClasses: typeof DEFAULT_ACCENT }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="mt-2 md:mt-0 h-1.5 w-full md:w-16 rounded-full bg-[var(--surface-0)] overflow-hidden">
      <motion.div
        className={`h-full rounded-full ${accentClasses.bar}`}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
      />
    </div>
  );
}

// ─── Dot Indicators ─────────────────────────────────────────────────────────

function DotIndicators({ dots, accentClasses }: { dots: boolean[]; accentClasses: typeof DEFAULT_ACCENT }) {
  return (
    <div className="mt-2 flex items-center gap-1">
      {dots.map((filled, i) => (
        <div
          key={i}
          className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
            filled ? accentClasses.dot : 'bg-[var(--surface-0)]'
          }`}
        />
      ))}
    </div>
  );
}

// ─── Sparkline SVG ──────────────────────────────────────────────────────────

function Sparkline({ data, accentClasses }: { data: number[]; accentClasses: typeof DEFAULT_ACCENT }) {
  if (data.length < 2) return null;

  const width = 80;
  const height = 24;
  const padding = 2;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data.map((val, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2);
    const y = height - padding - ((val - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  });

  const pathD = points.reduce((acc, point, i) => {
    return i === 0 ? `M ${point}` : `${acc} L ${point}`;
  }, '');

  return (
    <svg width={width} height={height} className="mt-1.5 md:mt-0" viewBox={`0 0 ${width} ${height}`}>
      <path
        d={pathD}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={accentClasses.value}
      />
      {points.length > 0 && (
        <circle
          cx={parseFloat(points[points.length - 1].split(',')[0])}
          cy={parseFloat(points[points.length - 1].split(',')[1])}
          r="2"
          fill="currentColor"
          className={accentClasses.value}
        />
      )}
    </svg>
  );
}

// ─── Value Display ──────────────────────────────────────────────────────────

function KpiValue({ definition, data, accentClasses }: {
  definition: KpiCardDefinition;
  data: KpiCardData;
  accentClasses: typeof DEFAULT_ACCENT;
}) {
  const { visualType } = definition;

  switch (visualType) {
    case 'fraction':
      return (
        <p className={`text-2xl font-bold ${accentClasses.value}`}>
          <AnimatedCounter value={data.value} className={accentClasses.value} />
          <span className="text-[var(--text-tertiary)] text-lg font-normal">/{data.max || 0}</span>
        </p>
      );
    case 'percentage':
      return (
        <p className={`text-2xl font-bold ${accentClasses.value}`}>
          <AnimatedCounter value={data.value} className={accentClasses.value} />
          <span className="text-lg">%</span>
        </p>
      );
    case 'counter_dots':
      return (
        <p className={`text-2xl font-bold ${accentClasses.value}`}>
          <AnimatedCounter value={data.value} className={accentClasses.value} />
          <span className="text-[var(--text-tertiary)] text-sm font-normal ml-1">days</span>
        </p>
      );
    case 'fraction_dots':
      return (
        <p className={`text-2xl font-bold ${accentClasses.value}`}>
          <AnimatedCounter value={data.value} className={accentClasses.value} />
          <span className="text-[var(--text-tertiary)] text-lg font-normal">/{data.max || 3}</span>
        </p>
      );
    case 'counter_sparkline':
      return (
        <p className={`text-2xl font-bold ${accentClasses.value}`}>
          {data.value}
        </p>
      );
    default:
      return (
        <p className={`text-2xl font-bold ${accentClasses.value}`}>
          <AnimatedCounter value={data.value} className={accentClasses.value} />
        </p>
      );
  }
}

// ─── Secondary Visual ───────────────────────────────────────────────────────

function KpiSecondary({ definition, data, accentClasses }: {
  definition: KpiCardDefinition;
  data: KpiCardData;
  accentClasses: typeof DEFAULT_ACCENT;
}) {
  const { visualType } = definition;

  switch (visualType) {
    case 'fraction':
    case 'percentage':
      return <ProgressBar value={data.value} max={data.max || 100} accentClasses={accentClasses} />;
    case 'counter_dots':
    case 'fraction_dots':
      return data.dots ? <DotIndicators dots={data.dots} accentClasses={accentClasses} /> : null;
    case 'counter_sparkline':
      return data.sparkline ? <Sparkline data={data.sparkline} accentClasses={accentClasses} /> : null;
    default:
      return null;
  }
}

// ─── Main KPI Card ──────────────────────────────────────────────────────────

interface KpiCardProps {
  definition: KpiCardDefinition;
  data: KpiCardData;
  onClick?: () => void;
  active?: boolean;
  /** Compact mode — hides subtitle text (used when 6 cards are shown on smaller screens) */
  compact?: boolean;
}

export function KpiCard({ definition, data, onClick, active, compact }: KpiCardProps) {
  const effectiveAccent = data.accent || (data.value > 0 ? definition.accent : undefined);
  const accentClasses = getAccent(effectiveAccent, data.value);
  const IconComponent = ICON_MAP[definition.icon];
  const isClickable = !!onClick;
  const subtitle = data.subtitle || definition.subtitle;

  const hasInlineSecondary = definition.visualType === 'counter_sparkline' || definition.visualType === 'percentage' || definition.visualType === 'fraction';

  return (
    <motion.div
      className={`bg-[var(--surface-1)] rounded-lg border p-2.5 md:p-3 min-w-0 h-[88px] flex flex-col justify-center ${accentClasses.border} ${
        active ? 'ring-2 ring-[var(--accent)]/50' : ''
      } ${isClickable ? 'cursor-pointer hover:bg-[var(--surface-2)] transition-colors duration-150' : ''}`}
      variants={statCardVariants}
      onClick={onClick}
      whileTap={isClickable ? { scale: 0.96 } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm text-[var(--text-tertiary)] truncate">{definition.label}</p>
            {IconComponent && (
              <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${accentClasses.icon}`}>
                <IconComponent size={12} />
              </div>
            )}
          </div>
          <KpiValue definition={definition} data={data} accentClasses={accentClasses} />
          {subtitle && !compact && (
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5 hidden md:block">{subtitle}</p>
          )}
        </div>
        {/* Inline secondary on the right for sparklines and progress bars at md+ */}
        {hasInlineSecondary && (
          <div className="hidden md:flex items-center flex-shrink-0">
            <KpiSecondary definition={definition} data={data} accentClasses={accentClasses} />
          </div>
        )}
      </div>
      {/* Below-content secondary for mobile, or for dot-type visuals */}
      {hasInlineSecondary ? (
        <div className="md:hidden">
          <KpiSecondary definition={definition} data={data} accentClasses={accentClasses} />
        </div>
      ) : (
        <KpiSecondary definition={definition} data={data} accentClasses={accentClasses} />
      )}
    </motion.div>
  );
}
