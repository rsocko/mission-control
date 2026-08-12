'use client';

import { Archive, CalendarClock, Flame, PartyPopper, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface MobileTriageEmptyProps {
  stats: {
    processedToday: number;
    streak: number;
    totalProcessed: number;
  };
  onCheckLater?: () => void;
  onBrowseArchive?: () => void;
}

function StatCard({
  label,
  value,
  icon: Icon,
  accentClassName,
}: {
  label: string;
  value: string;
  icon: typeof PartyPopper;
  accentClassName: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-[20px] bg-white/[0.04] px-3 py-3 text-left ring-1 ring-white/6 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full ring-1',
            accentClassName,
          )}
        >
          <Icon size={15} />
        </div>
        <span className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
          {label}
        </span>
      </div>
      <span className="mt-3 truncate text-lg font-semibold tabular-nums text-white">
        {value}
      </span>
    </div>
  );
}

export default function MobileTriageEmpty({
  stats,
  onCheckLater,
  onBrowseArchive,
}: MobileTriageEmptyProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-hidden bg-slate-950 px-5 py-8 text-center text-white">
      <div className="mobile-triage-empty-content">
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/12 shadow-[0_0_0_10px_rgba(16,185,129,0.08)] ring-1 ring-emerald-400/25">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-400/15 ring-1 ring-emerald-300/20">
            <PartyPopper size={34} className="text-emerald-300" />
          </div>
        </div>

        <div className="mt-6 space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-emerald-300 ring-1 ring-emerald-400/20">
            <Sparkles size={12} />
            Inbox zero
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-white">All caught up! 🎉</h2>
          <p className="mx-auto max-w-[18rem] text-sm leading-6 text-slate-400">
            Your triage queue is empty. Nice work clearing everything for now.
          </p>
        </div>

        <div className="mt-6 grid w-full max-w-sm grid-cols-3 gap-2 text-left">
          <StatCard
            label="Today"
            value={String(stats.processedToday)}
            icon={PartyPopper}
            accentClassName="bg-emerald-400/12 text-emerald-300 ring-emerald-400/20"
          />
          <StatCard
            label="Streak"
            value={`🔥 ${stats.streak}`}
            icon={Flame}
            accentClassName="bg-amber-400/12 text-amber-300 ring-amber-400/20"
          />
          <StatCard
            label="Total"
            value={String(stats.totalProcessed)}
            icon={Sparkles}
            accentClassName="bg-sky-400/12 text-sky-300 ring-sky-400/20"
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onCheckLater}
            disabled={!onCheckLater}
            className={cn(
              'inline-flex items-center gap-2 rounded-full bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-slate-200 ring-1 ring-white/10 backdrop-blur-sm transition duration-200',
              onCheckLater
                ? 'hover:bg-white/[0.07] hover:text-white active:scale-[0.98]'
                : 'cursor-default opacity-60',
            )}
          >
            <CalendarClock size={16} className="text-slate-400" />
            Check back later
          </button>
          <button
            type="button"
            onClick={onBrowseArchive}
            disabled={!onBrowseArchive}
            className={cn(
              'inline-flex items-center gap-2 rounded-full bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-slate-200 ring-1 ring-white/10 backdrop-blur-sm transition duration-200',
              onBrowseArchive
                ? 'hover:bg-white/[0.07] hover:text-white active:scale-[0.98]'
                : 'cursor-default opacity-60',
            )}
          >
            <Archive size={16} className="text-slate-400" />
            Browse archive
          </button>
        </div>
      </div>

    </div>
  );
}
