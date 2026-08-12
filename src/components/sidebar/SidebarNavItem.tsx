import type { ReactNode } from 'react';

interface SidebarNavItemProps {
  icon: ReactNode;
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
  color?: string;
  action?: ReactNode;
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
  subtitle,
  suffix,
  showZeroCount = false,
}: SidebarNavItemProps) {
  return (
    <div className={`flex items-center rounded-md ${
      active ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
    }`}>
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="flex w-5 flex-shrink-0 items-center justify-center">{icon}</span>
        <span className="flex-1 truncate text-sm font-medium">
          {label}
          {subtitle && <span className="ml-1 text-[12px] font-normal text-[var(--text-muted)]">{subtitle}</span>}
        </span>
        {suffix}
        {(showZeroCount || count > 0) && (
          <span className={`text-xs tabular-nums ${active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
            {count}
          </span>
        )}
        {color && <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      </button>
      {action}
    </div>
  );
}
