'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Grid2X2, List } from 'lucide-react';
import { ViewInGraphLink } from '@/components/graph/ViewInGraphLink';
import { buildTaskCollectionOriginHref } from '@/lib/graph/graph-navigation';
import type { TaskFilterContext } from '@/lib/task-filter-context';
import { cn } from '@/lib/utils';

const VIEWS = [
  { href: '/', label: 'List', icon: List },
  { href: '/matrix', label: 'Matrix', icon: Grid2X2 },
] as const;

interface TaskViewSwitcherProps {
  context: TaskFilterContext;
  originHref: string;
  originLabel: string;
}

export function TaskViewSwitcher({ context, originHref, originLabel }: TaskViewSwitcherProps) {
  const pathname = usePathname();

  return (
    <div
      aria-label="Task view"
      className="flex items-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] p-0.5"
    >
      {VIEWS.map((view) => {
        const active = pathname === view.href;
        const Icon = view.icon;
        return (
          <Link
            key={view.href}
            href={view.href}
            aria-label={`${view.label} task view`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-[var(--surface-2)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
            )}
          >
            <Icon size={12} aria-hidden="true" />
            <span className="hidden lg:inline">{view.label}</span>
          </Link>
        );
      })}
      <ViewInGraphLink
        context={context}
        origin={{
          href: buildTaskCollectionOriginHref(originHref, context),
          label: originLabel,
        }}
        compact
        showResponsiveLabel
        className="min-h-0 min-w-0 px-2 py-1"
      />
    </div>
  );
}
