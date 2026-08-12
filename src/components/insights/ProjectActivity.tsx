'use client';

import { useRouter } from 'next/navigation';
import type { ProjectActivityItem } from '@/lib/stats/insights';

interface Props {
  data: ProjectActivityItem[];
}

export function ProjectActivity({ data }: Props) {
  const router = useRouter();

  if (data.length === 0) {
    return <div className="py-6 text-center text-sm text-slate-500">No project activity this period</div>;
  }

  return (
    <div className="space-y-3">
      {data.map(project => (
        <button
          type="button"
          key={project.projectId}
          className="flex w-full items-center gap-3 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-slate-800/60"
          onClick={() => router.push(`/projects/${encodeURIComponent(project.projectId)}`)}
          title={`${project.projectName}: ${project.completed.toLocaleString()} completed, ${project.open.toLocaleString()} open (net ${project.delta >= 0 ? '+' : ''}${project.delta.toLocaleString()})`}
        >
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
          />
          <span className="w-36 truncate text-sm text-slate-300">{project.projectName}</span>
          <span className="flex flex-1 items-center gap-2">
            <span className="text-xs tabular-nums text-emerald-400">{project.completed.toLocaleString()} done</span>
            <span className="text-xs text-slate-600">/</span>
            <span className="text-xs tabular-nums text-slate-400">{project.open.toLocaleString()} open</span>
          </span>
          <span className={`text-xs font-medium tabular-nums ${project.delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {project.delta >= 0 ? '+' : ''}{project.delta.toLocaleString()}
          </span>
        </button>
      ))}
    </div>
  );
}
