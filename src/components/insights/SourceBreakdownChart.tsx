'use client';

import type { ReactNode } from 'react';
import { Calendar, CheckSquare, ClipboardList, GitBranch, Link2, Mail } from 'lucide-react';
import { addInsightsReturnContext } from '@/lib/navigation/insights';
import { pushAppHistoryDetail } from '@/lib/navigation/app-history';
import type { InsightsPeriod, SourceBreakdownItem } from '@/lib/stats/insights';

const SOURCE_ICONS: Record<string, ReactNode> = {
  'microsoft-todo': <CheckSquare size={14} />,
  'github': <GitBranch size={14} />,
  'email': <Mail size={14} />,
  'calendar': <Calendar size={14} />,
  'webhook': <Link2 size={14} />,
};

const DEFAULT_ICON = <ClipboardList size={14} />;

const SOURCE_LABELS: Record<string, string> = {
  'microsoft-todo': 'Microsoft Todo',
  'github': 'GitHub',
  'email': 'Email',
  'calendar': 'Calendar',
  'webhook': 'Webhook',
};

const SOURCE_COLORS: Record<string, string> = {
  'microsoft-todo': 'bg-blue-500',
  'github': 'bg-purple-500',
  'email': 'bg-emerald-500',
  'calendar': 'bg-amber-500',
  'webhook': 'bg-cyan-500',
};

interface Props {
  data: SourceBreakdownItem[];
  period: InsightsPeriod;
}

export function SourceBreakdownChart({ data, period }: Props) {
  if (data.length === 0) {
    return <div className="text-sm text-slate-500 text-center py-8">No completions this period</div>;
  }

  const maxCount = Math.max(...data.map(d => d.count));

  const handleSourceClick = (source: string) => {
    const params = new URLSearchParams();
    params.set('source', source);
    addInsightsReturnContext(params, period);
    const href = `/?${params.toString()}`;
    pushAppHistoryDetail(href, {
      kind: 'detail',
      param: 'origin',
      parentHref: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    });
  };

  return (
    <div className="space-y-3">
      {data.map(item => (
        <button
          type="button"
          key={item.source}
          className="flex w-full items-center gap-3 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-slate-800/60"
          onClick={() => handleSourceClick(item.source)}
          title={`${SOURCE_LABELS[item.source] ?? item.source}: ${item.count.toLocaleString()} (${item.percentage}%) — Click to filter`}
        >
          <span className="text-xs w-4">{SOURCE_ICONS[item.source] ?? DEFAULT_ICON}</span>
          <span className="text-sm text-slate-300 w-28 truncate">
            {SOURCE_LABELS[item.source] ?? item.source}
          </span>
          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${SOURCE_COLORS[item.source] ?? 'bg-slate-500'}`}
              style={{ width: `${maxCount > 0 ? (item.count / maxCount) * 100 : 0}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-slate-400 w-8 text-right">{item.count.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}
