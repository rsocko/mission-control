import type { ReactNode } from 'react';

interface SidebarNavItemProps {
  icon: ReactNode;
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
  color?: string;
  action?: ReactNode;
  overlayAction?: ReactNode;
  overlayActionVisible?: boolean;
  subtitle?: string;
  suffix?: ReactNode;
  showZeroCount?: boolean;
}

export function SidebarNavItem({
  icon,
  label,
  count,
  active,
  onClick,
  color,
  action,
  overlayAction,
  overlayActionVisible = false,
  subtitle,
  suffix,
  showZeroCount = false,
}: SidebarNavItemProps) {
  return (
    <div className={`group/nav flex items-center rounded-md ${
      active ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
    }`}>
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          onClick={onClick}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <span className="flex w-5 flex-shrink-0 items-center justify-center">{icon}</span>
          <span className="flex-1 truncate text-sm font-medium">
            {label}
            {subtitle && <span className="ml-1 text-[12px] font-normal text-[var(--text-muted)]">{subtitle}</span>}
          </span>
          {suffix}
          {(showZeroCount || count > 0) && (
            <span className={`ml-auto w-8 shrink-0 text-right text-xs tabular-nums transition-opacity ${
              active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
            } ${
              overlayAction
                ? overlayActionVisible
                  ? 'opacity-0'
                  : 'group-hover/nav:opacity-0 group-focus-within/nav:opacity-0'
                : ''
            }`}>
              {count}
            </span>
          )}
          {color && <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />}
        </button>
        {overlayAction && (
          <div className="absolute inset-y-0 right-1 flex items-center">
            {overlayAction}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}
