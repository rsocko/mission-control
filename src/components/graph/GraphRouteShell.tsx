'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChartNetwork, Cloud, Lightbulb, Orbit, Tags } from 'lucide-react';
import { cn } from '@/lib/utils';

const VIEWS = [
  { href: '/projects', label: 'Project', icon: ChartNetwork },
  { href: '/graph/ideation', label: 'Ideation', icon: Lightbulb },
  { href: '/graph/universe', label: 'Universe', icon: Orbit },
  { href: '/graph/tags', label: 'Tags', icon: Tags },
  { href: '/graph/words', label: 'Words', icon: Cloud },
] as const;

export function GraphRouteShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <nav aria-label="Graph views" className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface-1)] px-3">
        <span className="mr-2 shrink-0 text-sm font-semibold text-[var(--text-primary)]">Graph</span>
        {VIEWS.map((view) => {
          const active = pathname === view.href || pathname.startsWith(`${view.href}/`);
          const Icon = view.icon;
          return (
            <Link
              key={view.href}
              href={view.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors',
                active
                  ? 'bg-[var(--accent-600)] text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
              )}
            >
              <Icon size={14} /> {view.label}
            </Link>
          );
        })}
      </nav>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
