'use client';

import { useRouter } from 'next/navigation';
import { Check, X as XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoutineHeatmapEntry } from '@/lib/stats/insights';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Props {
  data: RoutineHeatmapEntry[];
}

export function RoutineHeatmap({ data }: Props) {
  const router = useRouter();

  if (data.length === 0) {
    return <div className="text-sm text-slate-500 text-center py-6">No active routines</div>;
  }

  const handleRoutineClick = (routineId: string) => {
    router.push(`/routines?highlight=${routineId}`);
  };

  const getDayTooltip = (routineName: string, dayLabel: string, status: boolean | null): string => {
    if (status === true) return `${routineName} — ${dayLabel}: Completed ✓`;
    if (status === false) return `${routineName} — ${dayLabel}: Missed ✗`;
    return `${routineName} — ${dayLabel}: Not scheduled`;
  };

  return (
    <div className="space-y-2">
      {/* Day labels header */}
      <div className="flex items-center gap-2 pl-32">
        {DAY_LABELS.map(day => (
          <span key={day} className="w-7 text-center text-[10px] text-slate-500">
            {day}
          </span>
        ))}
      </div>

      {/* Routine rows */}
      {data.map(routine => (
        <div key={routine.routineId} className="flex items-center gap-2">
          <div
            className="w-32 flex items-center gap-2 truncate cursor-pointer hover:text-white transition-colors"
            onClick={() => handleRoutineClick(routine.routineId)}
            title={`${routine.routineName} — Click to view routine`}
          >
            {routine.icon && <span className="text-sm">{routine.icon}</span>}
            <span className="text-xs text-slate-300 truncate">{routine.routineName}</span>
          </div>
          <div className="flex items-center gap-2">
            {routine.days.map((status, i) => (
              <div
                key={i}
                className={cn(
                  'w-7 h-7 rounded-md flex items-center justify-center text-[10px]',
                  status === true && 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
                  status === false && 'bg-red-500/10 text-red-400/50 border border-red-500/20',
                  status === null && 'bg-slate-800/40 text-slate-600',
                )}
                title={getDayTooltip(routine.routineName, DAY_LABELS[i], status)}
              >
                {status === true ? <Check size={10} /> : status === false ? <XIcon size={10} /> : '·'}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
