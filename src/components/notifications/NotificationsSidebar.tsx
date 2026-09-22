'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  AlertTriangle, ClipboardCheck, BellRing, Info, Newspaper, Inbox,
  ChevronRight, PanelLeftClose, PanelLeftOpen, Globe,
  Mail, MailOpen, Eye, EyeOff, Settings, Calendar, Server, Shapes,
  Radio, Package, Bell, Wrench, CircleAlert, type LucideIcon,
} from 'lucide-react';
import type { UseNotificationsReturn } from '@/lib/hooks/useNotifications';
import type { NotificationLevel, NotificationState } from '@/types';
import { NOTIFICATION_SOURCE_ICONS } from '@/types/dashboard';
import {
  formatNotificationSourceLabel,
  formatNotificationTypeLabel,
} from '@/lib/notifications/categories';

// ─── Sidebar item (mirrors dashboard SidebarItem) ────────────────────────────

function SidebarItem({
  icon,
  label,
  count,
  active,
  onClick,
  nested,
  expanded,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
  nested?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] ${
        active
          ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'hover:bg-[var(--surface-2)] text-[var(--text-secondary)]'
      } ${nested ? 'pl-7' : ''}`}
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
      {expanded !== undefined && (
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
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
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="mb-2 flex flex-1 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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

function notificationTypeIcon(notificationType: string): React.ReactNode {
  switch (notificationType) {
    case 'home_assistant_entity_alert':
      return <Radio size={13} className="text-cyan-400" />;
    case 'ha_update_available':
      return <Package size={13} className="text-blue-400" />;
    case 'ha_update_critical':
      return <Package size={13} className="text-red-400" />;
    case 'ha_persistent_notification':
      return <Bell size={13} className="text-blue-400" />;
    case 'ha_persistent_critical':
      return <Bell size={13} className="text-red-400" />;
    case 'ha_repair_warning':
      return <Wrench size={13} className="text-amber-400" />;
    case 'ha_repair_error':
      return <Wrench size={13} className="text-orange-400" />;
    case 'ha_repair_critical':
      return <CircleAlert size={13} className="text-red-400" />;
    default:
      return <Shapes size={13} />;
  }
}

// ─── Main component ──────────────────────────────────────────────────────────

interface NotificationsSidebarProps {
  hook: Pick<
    UseNotificationsReturn,
    | 'facets'
    | 'filters'
    | 'setLevelFilter'
    | 'setSourceFilter'
    | 'setSourceAccountFilter'
    | 'setNotificationTypeFilter'
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
  const visibleTypes = filters.source ? facets.notificationType : [];

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
      {/* ── Source section ── */}
      {Object.keys(facets.source).length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between">
            <SectionHeader
              label="Source"
              collapsed={collapsedSections.has('source')}
              onToggle={() => toggleSection('source')}
              hasActiveFilter={!!filters.source}
            />
            <button
              type="button"
              onClick={onToggleCollapse}
              className="rounded p-1 text-[var(--text-muted)] transition-colors duration-100 hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={13} />
            </button>
          </div>
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
                .map(([source, count]) => {
                  const instances = facets.sourceAccount
                    .filter(instance => instance.source === source)
                    .sort((left, right) => left.label.localeCompare(right.label));
                  const hasMultipleInstances = instances.length > 1;
                  const expanded = filters.source === source && hasMultipleInstances;
                  return (
                    <React.Fragment key={source}>
                      <SidebarItem
                        icon={
                          NOTIFICATION_SOURCE_ICONS[source] ? (
                            <Image
                              src={NOTIFICATION_SOURCE_ICONS[source]}
                              alt=""
                              width={14}
                              height={14}
                            />
                          ) : (
                            <Globe size={14} />
                          )
                        }
                        label={formatNotificationSourceLabel(source)}
                        count={count}
                        active={
                          filters.source === source
                          && (!filters.sourceAccount || !hasMultipleInstances)
                        }
                        expanded={hasMultipleInstances ? expanded : undefined}
                        onClick={() => hook.setSourceFilter(
                          filters.source === source ? null : source,
                        )}
                      />
                      {expanded && instances.map(instance => (
                        <SidebarItem
                          key={instance.key}
                          icon={<Server size={13} />}
                          label={instance.label}
                          count={instance.count}
                          nested
                          active={filters.sourceAccount === instance.key}
                          onClick={() => hook.setSourceAccountFilter(
                            filters.sourceAccount === instance.key ? null : instance.key,
                          )}
                        />
                      ))}
                    </React.Fragment>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* ── Level section ── */}
      <div className="mb-4">
        <div className="flex items-center justify-between">
          <SectionHeader
            label="Level"
            collapsed={collapsedSections.has('level')}
            onToggle={() => toggleSection('level')}
            hasActiveFilter={!!filters.level}
          />
          {Object.keys(facets.source).length === 0 && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="rounded p-1 text-[var(--text-muted)] transition-colors duration-100 hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={13} />
            </button>
          )}
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

      {/* ── Type section (scoped to the active source/instance) ── */}
      <div className="mb-4">
        <SectionHeader
          label="Type"
          collapsed={collapsedSections.has('notificationType')}
          onToggle={() => toggleSection('notificationType')}
          hasActiveFilter={!!filters.notificationType}
        />
        {!collapsedSections.has('notificationType') && (
          filters.source && visibleTypes.length > 0 ? (
            <div className="space-y-0.5">
              <SidebarItem
                icon={<Shapes size={14} className="text-blue-400" />}
                label="All Types"
                count={visibleTypes.reduce((sum, type) => sum + type.count, 0)}
                active={!filters.notificationType}
                onClick={() => hook.setNotificationTypeFilter(null)}
              />
              {visibleTypes.map(type => (
                <SidebarItem
                  key={type.key}
                  icon={notificationTypeIcon(type.key)}
                  label={formatNotificationTypeLabel(type.key)}
                  count={type.count}
                  active={filters.notificationType === type.key}
                  onClick={() => hook.setNotificationTypeFilter(
                    filters.notificationType === type.key ? null : type.key,
                  )}
                />
              ))}
            </div>
          ) : (
            <div className="flex items-start gap-2 px-2 py-1.5 text-xs leading-4 text-[var(--text-muted)]">
              <Shapes size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                {filters.source
                  ? 'No notification types for this source.'
                  : 'Choose a source to see its types.'}
              </span>
            </div>
          ))}
      </div>

      {savedViews}

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
