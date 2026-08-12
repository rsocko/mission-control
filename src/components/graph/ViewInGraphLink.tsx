'use client';

import Link from 'next/link';
import { Network } from 'lucide-react';
import {
  buildGraphUniverseHref,
  type GraphOrigin,
} from '@/lib/graph/graph-navigation';
import type { TaskFilterContext } from '@/lib/task-filter-context';
import { cn } from '@/lib/utils';

interface ViewInGraphLinkProps {
  context: TaskFilterContext;
  origin: GraphOrigin;
  className?: string;
  compact?: boolean;
  showResponsiveLabel?: boolean;
  collectionLabel?: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}

export function ViewInGraphLink({
  context,
  origin,
  className,
  compact = false,
  showResponsiveLabel = false,
  collectionLabel,
  onClick,
}: ViewInGraphLinkProps) {
  return (
    <Link
      href={buildGraphUniverseHref({ context, origin })}
      onClick={onClick}
      aria-label={`View ${collectionLabel ?? origin.label} in Graph`}
      className={cn(
        'inline-flex items-center justify-center gap-1 rounded text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-400)]',
        compact
          ? 'min-h-8 min-w-8 p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
          : 'px-3 py-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
        className,
      )}
    >
      <Network size={13} aria-hidden="true" />
      {compact ? (
        <span className={showResponsiveLabel ? 'hidden lg:inline' : 'sr-only'}>Graph</span>
      ) : <span>Graph</span>}
    </Link>
  );
}
