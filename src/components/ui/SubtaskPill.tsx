'use client';

interface SubtaskPillProps {
  done: number;
  total: number;
  className?: string;
}

/**
 * Pie-chart progress pill for subtask counts.
 * Shows a filled pie wedge snapped to 10% increments (capped at 80% until complete)
 * plus "done/total" text. Accent blue while in-progress, green at 100%.
 */
export function SubtaskPill({ done, total, className = '' }: SubtaskPillProps) {
  if (total <= 0) return null;

  const rawPct = Math.min(done / total, 1);
  const isComplete = done === total;

  // Snap to 10% increments; cap at 80% until fully complete
  const snapped = isComplete
    ? 1
    : Math.min(Math.floor(rawPct * 10) / 10, 0.8);

  // Pie chart geometry
  const cx = 7;
  const cy = 7;
  const r = 6;

  // Build a pie wedge path for the filled portion
  function piePath(fraction: number): string {
    if (fraction <= 0) return '';
    if (fraction >= 1)
      return `M${cx},${cy} m-${r},0 a${r},${r} 0 1,1 ${r * 2},0 a${r},${r} 0 1,1 -${r * 2},0 Z`;
    const angle = fraction * 2 * Math.PI;
    const x = cx + r * Math.sin(angle);
    const y = cy - r * Math.cos(angle);
    const largeArc = fraction > 0.5 ? 1 : 0;
    return `M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${largeArc} 1 ${x},${y} Z`;
  }

  const accentColor = isComplete ? '#4ade80' : '#60a5fa'; // green-400 : blue-400
  const trackColor = isComplete ? 'rgba(74,222,128,0.2)' : 'rgba(96,165,250,0.2)';
  const bgClass = isComplete ? 'bg-green-400/10' : 'bg-blue-400/10';
  const textClass = isComplete ? 'text-green-400' : 'text-blue-400';

  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums ${bgClass} ${textClass} ${className}`}
      title={`${done} of ${total} subtasks complete`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        className="shrink-0"
      >
        {/* Background circle */}
        <circle cx={cx} cy={cy} r={r} fill={trackColor} />
        {/* Filled pie wedge */}
        {snapped > 0 && (
          <path d={piePath(snapped)} fill={accentColor} />
        )}
      </svg>
      {done}/{total}
    </span>
  );
}
