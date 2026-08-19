'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  AlertTriangle, ClipboardCheck, BellRing, Info, Newspaper, Inbox,
  ChevronRight, PanelLeftClose, PanelLeftOpen, Globe,
  Mail, MailOpen, Eye, EyeOff, Settings, Calendar,
  type LucideIcon,
} from 'lucide-react';
import type { UseNotificationsReturn } from '@/lib/hooks/useNotifications';
import type { NotificationLevel, NotificationState } from '@/types';
import { NOTIFICATION_SOURCE_ICONS } from '@/types/dashboard';
import { formatNotificationSourceLabel } from '@/lib/notifications/categories';

// ─── Sidebar item (mirrors dashboard SidebarItem) ────────────────────────────

function SidebarItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer w-full text-left ${
        active
          ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'hover:bg-[var(--surface-2)] text-[var(--text-secondary)]'
      }`}
    >
      <span className="w-5 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span className="text-sm font-medium flex-1 truncate">{label}</span>
      {count > 0 && (
        <span
          className={`text-xs tabular-nums ${active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Collapsible section header ──────────────────────────────────────────────

function SectionHeader({
  label,
  collapsed,
  onToggle,
  hasActiveFilter,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  hasActiveFilter?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex-1 flex items-center gap-1 text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide hover:text-[var(--text-secondary)] transition-colors mb-2"
    >
      <ChevronRight
        size={11}
        className={`transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
      />
      {label}
      {collapsed && hasActiveFilter && (
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] ml-1 flex-shrink-0" />
      )}
    </button>
  );
}

// ─── Level config ────────────────────────────────────────────────────────────

const LEVEL_ITEMS: { value: NotificationLevel; label: string; icon: LucideIcon; color: string }[] = [
  { value: 'urgent', label: 'Urgent', icon: AlertTriangle, color: '#ef4444' },
  { value: 'action_needed', label: 'Action Needed', icon: ClipboardCheck, color: '#f59e0b' },
  { value: 'heads_up', label: 'Heads Up', icon: BellRing, color: '#3b82f6' },
  { value: 'fyi', label: 'FYI', icon: Info, color: '#64748b' },
  { value: 'digest', label: 'Digest', icon: Newspaper, color: '#a855f7' },
];

// ─── State config ────────────────────────────────────────────────────────────

const STATE_ITEMS: { value: NotificationState; label: string; icon: LucideIcon }[] = [
  { value: 'unread', label: 'Unread', icon: Mail },
  { value: 'read', label: 'Read', icon: MailOpen },
  { value: 'dismissed', label: 'Dismissed', icon: EyeOff },
];

// ─── Date Range config ───────────────────────────────────────────────────────

const DATE_RANGE_ITEMS: { value: 'today' | 'week' | 'month' | null; label: string }[] = [
  { value: null, label: 'Any Time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 Days' },
  { value: 'month', label: 'Last 30 Days' },
];

// ─── Main component ──────────────────────────────────────────────────────────

interface NotificationsSidebarProps {
  hook: Pick<
    UseNotificationsReturn,
    | 'facets'
    | 'filters'
    | 'setLevelFilter'
    | 'setSourceFilter'
    | 'setStateFilter'
    | 'setDateRangeFilter'
  >;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  savedViews?: React.ReactNode;
}

export function NotificationsSidebar({
  hook,
  collapsed,
  onToggleCollapse,
  savedViews,
}: NotificationsSidebarProps) {
  const { facets, filters } = hook;
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const toggleSection = (section: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });

  const totalCount = Object.values(facets.level).reduce((s, c) => s + c, 0);

  // Collapsed mini rail
  if (collapsed) {
    return (
      <aside
        aria-label="Notification filters (collapsed)"
        className="hidden sm:flex w-12 bg-[var(--surface-1)] border-r border-[var(--border)] py-3 flex-col items-center gap-1 flex-shrink-0"
      >
        <button
          onClick={onToggleCollapse}
          className="p-2 rounded-[var(--radius-md)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100 mb-2"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen size={16} />
        </button>

        <div className="w-6 h-px bg-[var(--border)] mb-2" />

        {/* Level quick icons */}
        <button
          onClick={() => hook.setLevelFilter(null)}
          className={`p-2 rounded-[var(--radius-md)] transition-colors duration-100 ${
            !filters.level
              ? 'text-[var(--accent)] bg-[var(--accent)]/10'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
          }`}
          title="All"
          aria-label="All notifications"
        >
          <Inbox size={16} />
        </button>
        {LEVEL_ITEMS.slice(0, 4).map(({ value, label, icon: Icon, color }) => (
          <button
            key={value}
            onClick={() => hook.setLevelFilter(filters.level === value ? null : value)}
            className={`p-2 rounded-[var(--radius-md)] transition-colors duration-100 ${
              filters.level === value
                ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
            }`}
            title={label}
            aria-label={`Filter by ${label}`}
          >
            <Icon size={16} style={{ color }} />
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside
      aria-label="Notification filters"
      className="hidden sm:flex flex-col w-56 bg-[var(--surface-1)] border-r border-[var(--border)] p-4 overflow-y-auto overflow-x-hidden flex-shrink-0"
    >
      {savedViews}

      {/* ── Level section ── */}
      <div className="mb-4">
        <div className="flex items-center justify-between">
          <SectionHeader
            label="Level"
            collapsed={collapsedSections.has('level')}
            onToggle={() => toggleSection('level')}
            hasActiveFilter={!!filters.level}
          />
          <button
            onClick={onToggleCollapse}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={13} />
          </button>
        </div>
        {!collapsedSections.has('level') && (
          <div className="space-y-0.5">
            <SidebarItem
              icon={<Inbox size={14} className="text-blue-400" />}
              label="All"
              count={totalCount}
              active={!filters.level}
              onClick={() => hook.setLevelFilter(null)}
            />
            {LEVEL_ITEMS.map(({ value, label, icon: Icon, color }) => (
              <SidebarItem
                key={value}
                icon={<Icon size={14} style={{ color }} />}
                label={label}
                count={facets.level[value] || 0}
                active={filters.level === value}
                onClick={() => hook.setLevelFilter(filters.level === value ? null : value)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Source section ── */}
      {Object.keys(facets.source).length > 0 && (
        <div className="mb-4">
          <SectionHeader
            label="Source"
            collapsed={collapsedSections.has('source')}
            onToggle={() => toggleSection('source')}
            hasActiveFilter={!!filters.source}
          />
          {!collapsedSections.has('source') && (
            <div className="space-y-0.5">
              <SidebarItem
                icon={<Globe size={14} className="text-blue-400" />}
                label="All Sources"
                count={totalCount}
                active={!filters.source}
                onClick={() => hook.setSourceFilter(null)}
              />
              {Object.entries(facets.source)
                .sort(([, a], [, b]) => b - a)
                .map(([source, count]) => (
                  <SidebarItem
                    key={source}
                    icon={
                      NOTIFICATION_SOURCE_ICONS[source] ? (
                        <Image
                          src={NOTIFICATION_SOURCE_ICONS[source]}
                          alt={source}
                          width={14}
                          height={14}
                        />
                      ) : (
                        <Globe size={14} />
                      )
                    }
                    label={formatNotificationSourceLabel(source)}
                    count={count}
                    active={filters.source === source}
                    onClick={() =>
                      hook.setSourceFilter(filters.source === source ? null : source)
                    }
                  />
                ))}
            </div>
          )}
        </div>
      )}

      {/* ── State section ── */}
      <div className="mb-4">
        <SectionHeader
          label="State"
          collapsed={collapsedSections.has('state')}
          onToggle={() => toggleSection('state')}
          hasActiveFilter={!!filters.state}
        />
        {!collapsedSections.has('state') && (
          <div className="space-y-0.5">
            <SidebarItem
              icon={<Eye size={14} className="text-blue-400" />}
              label="All"
              count={totalCount}
              active={!filters.state}
              onClick={() => hook.setStateFilter(null)}
            />
            {STATE_ITEMS.map(({ value, label, icon: Icon }) => (
              <SidebarItem
                key={value}
                icon={<Icon size={14} />}
                label={label}
                count={facets.state[value] || 0}
                active={filters.state === value}
                onClick={() =>
                  hook.setStateFilter(filters.state === value ? null : value)
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Date Range section ── */}
      <div className="mb-4">
        <SectionHeader
          label="Time"
          collapsed={collapsedSections.has('dateRange')}
          onToggle={() => toggleSection('dateRange')}
          hasActiveFilter={!!filters.dateRange}
        />
        {!collapsedSections.has('dateRange') && (
          <div className="space-y-0.5">
            {DATE_RANGE_ITEMS.map(({ value, label }) => (
              <SidebarItem
                key={value ?? 'all'}
                icon={<Calendar size={14} />}
                label={label}
                count={0}
                active={filters.dateRange === value}
                onClick={() =>
                  hook.setDateRangeFilter(filters.dateRange === value ? null : value)
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Preferences link ── */}
      <div className="mt-auto pt-4 border-t border-[var(--border)]">
        <Link
          href="/settings/notifications"
          className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
        >
          <Settings size={14} />
          <span className="text-xs font-medium">Notification Preferences</span>
        </Link>
      </div>
    </aside>
  );
}
