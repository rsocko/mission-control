import type {
  DashboardProjectViewModel as HubProject,
} from '@/types/dashboard';
import type { FilterToken, FilterTokenType } from '@/lib/utils/parseFilterQuery';

export const FILTER_TOKEN_STYLES: Record<FilterTokenType, { bg: string; text: string; border: string }> = {
  title: { bg: 'bg-purple-500/15', text: 'text-purple-300', border: 'border-purple-500/30' },
  tag: { bg: 'bg-green-500/15', text: 'text-green-300', border: 'border-green-500/30' },
  priority: { bg: 'bg-red-500/20', text: 'text-red-300', border: 'border-red-500/30' },
  status: { bg: 'bg-yellow-500/15', text: 'text-yellow-300', border: 'border-yellow-500/30' },
  source: { bg: 'bg-blue-500/15', text: 'text-blue-300', border: 'border-blue-500/30' },
  list: { bg: 'bg-cyan-500/15', text: 'text-cyan-300', border: 'border-cyan-500/30' },
  listid: { bg: 'bg-cyan-500/15', text: 'text-cyan-300', border: 'border-cyan-500/30' },
  assignee: { bg: 'bg-orange-500/15', text: 'text-orange-300', border: 'border-orange-500/30' },
  due: { bg: 'bg-slate-500/15', text: 'text-slate-300', border: 'border-slate-500/30' },
  project: { bg: 'bg-indigo-500/15', text: 'text-indigo-300', border: 'border-indigo-500/30' },
  phase: { bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-300', border: 'border-fuchsia-500/30' },
  disposition: { bg: 'bg-emerald-500/15', text: 'text-emerald-300', border: 'border-emerald-500/30' },
  text: { bg: '', text: '', border: '' },
};

export function getFilterTokenDisplayValue(token: FilterToken, projects: HubProject[]): string {
  if (token.value === 'none') {
    const noneLabels: Partial<Record<FilterTokenType, string>> = {
      assignee: 'No assignee',
      due: 'No due date',
      list: 'No list',
      phase: 'No phase',
      priority: 'No priority',
      project: 'No project',
      tag: 'No tags',
    };
    return noneLabels[token.type] ?? token.value;
  }
  if (token.type === 'project') {
    return projects.find((project) => project.id === token.value)?.name ?? token.value;
  }
  if (token.type === 'phase') {
    for (const project of projects) {
      const phase = project.phases?.find((candidate) => candidate.id === token.value);
      if (phase) return `${project.name} › ${phase.name}`;
    }
  }
  return token.value;
}
