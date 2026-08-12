'use client';

import { Brain, ChartNetwork, Filter, Lightbulb, Target, type LucideIcon } from 'lucide-react';
import { FilterButton } from './FilterButton';
import type { FilterType, LinkedProject } from './types';
import { cn } from '@/lib/utils/cn';

const FILTER_OPTIONS: Array<{
  value: FilterType;
  label: string;
  color: string;
  icon: LucideIcon;
}> = [
  { value: 'all', label: 'All', color: 'text-[var(--text-secondary)]', icon: Filter },
  { value: 'goal', label: 'Goals', color: 'text-blue-400', icon: Target },
  { value: 'idea', label: 'Ideas', color: 'text-amber-400', icon: Lightbulb },
  { value: 'brainstorm', label: 'Brainstorms', color: 'text-purple-400', icon: Brain },
];

interface ProjectCount {
  project: LinkedProject;
  count: number;
}

interface GoalsFiltersProps {
  filter: FilterType;
  counts: Record<'goal' | 'idea' | 'brainstorm', number>;
  totalCount: number;
  onFilterChange: (filter: FilterType) => void;
  projectFilter?: string | null;
  onProjectFilterChange?: (projectId: string | null) => void;
  projectCounts?: ProjectCount[];
}

export function GoalsSidebar({ filter, counts, totalCount, onFilterChange, projectFilter, onProjectFilterChange, projectCounts }: GoalsFiltersProps) {
  return (
    <aside className="w-56 bg-[var(--surface-0)] border-r border-[var(--border-subtle)] p-4 overflow-y-auto flex-shrink-0 hidden lg:block" aria-label="Goals filters">
      <div className="mb-6">
        <h3 className="text-[12px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-2">View</h3>
        <div className="space-y-0.5">
          {FILTER_OPTIONS.map(({ value, label, color, icon: Icon }) => (
            <FilterButton
              key={value}
              active={filter === value}
              onClick={() => onFilterChange(value)}
              icon={<Icon size={14} />}
              label={label}
              count={value === 'all' ? totalCount : counts[value]}
              color={color}
            />
          ))}
        </div>
      </div>

      {projectCounts && projectCounts.length > 0 && onProjectFilterChange && (
        <div className="mb-6">
          <h3 className="text-[12px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-2">Linked Project</h3>
          <div className="space-y-0.5">
            <button
              onClick={() => onProjectFilterChange(null)}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-md)] text-sm transition-colors duration-150',
                !projectFilter
                  ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
              )}
            >
              <ChartNetwork size={14} className={!projectFilter ? 'text-[var(--accent-400)]' : 'text-[var(--text-tertiary)]'} />
              <span className="font-medium">All Projects</span>
            </button>
            {projectCounts.map(({ project, count }) => (
              <button
                key={project.id}
                onClick={() => onProjectFilterChange(project.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-md)] text-sm transition-colors duration-150',
                  projectFilter === project.id
                    ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
                )}
              >
                <span
                  className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: project.color || 'var(--text-tertiary)' }}
                />
                <span className="font-medium truncate">{project.name}</span>
                <span
                  className={cn(
                    'ml-auto text-[12px] font-medium tabular-nums',
                    projectFilter === project.id ? 'text-[var(--accent-400)]' : 'text-[var(--text-tertiary)]'
                  )}
                >
                  {count}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

export function GoalsFilterChips({ filter, onFilterChange }: GoalsFiltersProps) {
  return (
    <div className="flex items-center gap-1.5 lg:hidden">
      {FILTER_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onFilterChange(value)}
          className={cn(
            'px-2.5 py-1 text-[12px] font-medium rounded-full transition-colors duration-150',
            filter === value
              ? 'bg-[var(--accent-600)] text-white'
              : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
