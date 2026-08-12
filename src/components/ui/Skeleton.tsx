import { cn } from '@/lib/utils';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-[var(--radius-md)] bg-[var(--surface-secondary)] motion-reduce:animate-none',
        className
      )}
    />
  );
}

export function TaskRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
      <Skeleton className="h-4 w-4 rounded-full flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-5 w-16 rounded-full" />
    </div>
  );
}

export function KpiCardSkeleton() {
  return (
    <div className="flex-1 min-w-[140px] rounded-[var(--radius-lg)] border border-[var(--border)] p-3 space-y-2">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-12" />
      <Skeleton className="h-2 w-16" />
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="flex h-full" role="status" aria-busy="true" aria-label="Loading dashboard">
      {/* Sidebar skeleton */}
      <div className="w-64 border-r border-[var(--border)] p-4 space-y-4 flex-shrink-0">
        <Skeleton className="h-8 w-full" />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>

      {/* Main content skeleton */}
      <div className="flex-1 p-4 space-y-4 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>

        {/* Task list - load these first */}
        <div className="space-y-0">
          {Array.from({ length: 8 }).map((_, i) => (
            <TaskRowSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function RouteLoadingSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 p-4 sm:p-6"
      role="status"
      aria-busy="true"
      aria-label="Loading page"
    >
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-20 flex-1" />
        <Skeleton className="hidden h-20 flex-1 sm:block" />
        <Skeleton className="hidden h-20 flex-1 lg:block" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)]">
        {Array.from({ length: 8 }).map((_, i) => (
          <TaskRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function MyDaySkeleton() {
  return (
    <div className="flex h-full">
      {/* Main panel */}
      <div className="flex-1 p-4 space-y-4 overflow-hidden">
        {/* Header */}
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>

        {/* Task list */}
        <div className="space-y-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <TaskRowSkeleton key={i} />
          ))}
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-72 border-l border-[var(--border)] p-4 space-y-4 flex-shrink-0">
        <Skeleton className="h-6 w-32" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-[var(--radius-lg)]" />
          ))}
        </div>
      </div>
    </div>
  );
}
