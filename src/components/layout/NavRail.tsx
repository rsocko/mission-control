'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import * as Popover from '@radix-ui/react-popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import { MissionControlIcon } from '@/components/ui/MissionControlIcon';
import { SyncingMissionControlIcon } from '@/components/ui/SyncingMissionControlIcon';
import { BRAND_GRADIENT_END, BRAND_GRADIENT_START } from '@/lib/brand';
import { formatSyncTime } from '@/lib/utils/dashboard-helpers';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Sun,
  ChartNetwork,
  Columns3,
  CalendarDays,
  // Headset — replaced by HoustonIcon
  Inbox,
  Settings,
  Target,
  Repeat,
  Activity,
  Bell,
  Zap,
  FileText,
  Coins,
  Pin,
  PinOff,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNavRailPrefs } from '@/lib/hooks/useNavRailPrefs';
import {
  getSyncIconPreference,
  resolveSyncIconVariant,
} from '@/lib/hooks/useSyncIconPreference';
import { CONNECTOR_ICONS } from '@/types/dashboard';
import type { ConnectorHealthInfo } from '@/lib/hooks/useSystemHealth';
import { getShortcutPage } from '@/lib/navigation/shortcut-catalog';
import { RecentProjectsNavItem } from '@/components/layout/RecentProjectsNavItem';

import type { ComponentType } from 'react';
import {
  NavigationRailMorph,
} from '@/components/layout/NavigationBadge';
import { useNavigationBadgePreferences } from '@/lib/hooks/useNavigationBadges';
import {
  EMPTY_NAVIGATION_COUNTS,
  type NavBadgeKey,
  type NavBadgeTone,
  type NavigationCounts,
} from '@/lib/navigation/badges';

interface NavRailItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconColor?: string;
  iconSize?: number;
  requiresFeature?: 'aiEnabled' | 'financeEnabled';
  badgeKey?: NavBadgeKey;
  badgeTone?: NavBadgeTone;
}

interface NavRailGroup {
  label: string;
  items: NavRailItem[];
}

function shortcutNavItem(
  href: string,
  icon: NavRailItem['icon'],
  extra: Omit<NavRailItem, 'href' | 'label' | 'icon' | 'iconColor'> = {},
): NavRailItem {
  const page = getShortcutPage(href);
  if (!page) throw new Error(`Missing shortcut catalog entry for ${href}`);
  return {
    href,
    label: page.name,
    icon,
    iconColor: page.iconColor,
    ...extra,
  };
}

function PhosphorGraphIcon({ size = 22, className }: { size?: number; className?: string }) {
  const maskImage = 'url(https://api.iconify.design/ph/graph.svg)';

  return (
    <span
      aria-hidden="true"
      className={className}
      data-icon="ph:graph"
      style={{
        width: size,
        height: size,
        backgroundColor: 'currentColor',
        mask: `${maskImage} center / contain no-repeat`,
        WebkitMask: `${maskImage} center / contain no-repeat`,
      }}
    />
  );
}

const navGroups: NavRailGroup[] = [
  {
    label: 'Plan',
    items: [
      shortcutNavItem('/', LayoutDashboard),
      shortcutNavItem('/today', Sun, { badgeKey: 'myDay', badgeTone: 'amber' }),
      shortcutNavItem('/projects', ChartNetwork),
      shortcutNavItem('/kanban', Columns3),
      shortcutNavItem('/goals', Target),
      shortcutNavItem('/timeline', CalendarDays),
    ],
  },
  {
    label: 'Operate',
    items: [
      shortcutNavItem('/notifications', Bell, { badgeKey: 'notifications', badgeTone: 'blue' }),
      shortcutNavItem('/routines', Repeat),
      shortcutNavItem('/triage', Inbox, { badgeKey: 'triage', badgeTone: 'red' }),
      shortcutNavItem('/quick-sort', Zap, { badgeKey: 'quickSort', badgeTone: 'amber' }),
      { href: '/scout/reconciliation', label: 'Reconciliation', icon: ShieldCheck, iconColor: 'text-emerald-400', badgeKey: 'reconciliation', badgeTone: 'amber' },
    ],
  },
  {
    label: 'Understand',
    items: [
      shortcutNavItem('/insights', Activity),
      { href: '/graph', label: 'Graph', icon: PhosphorGraphIcon, iconColor: 'text-indigo-400' },
      shortcutNavItem('/icons', Search),
    ],
  },
  {
    label: 'Domains',
    items: [
      { href: '/doc-intelligence', label: 'Docs', icon: FileText, iconColor: 'text-orange-400' },
      { href: '/finance', label: 'Money', icon: Coins, iconColor: 'text-amber-400', requiresFeature: 'financeEnabled' },
    ],
  },
  {
    label: 'Assistant',
    items: [
      shortcutNavItem('/ai', HoustonIcon, { iconSize: 26, requiresFeature: 'aiEnabled' }),
    ],
  },
];

const bottomItems: NavRailItem[] = [
  shortcutNavItem('/settings', Settings),
];

interface NavRailProps {
  features: { aiEnabled: boolean; financeEnabled?: boolean } | null;
  isAiActive: boolean;
  isSyncing?: boolean;
  counts?: NavigationCounts;
  syncStatus?: ConnectorHealthInfo[];
}

function ActiveSyncIcon({ className }: { className?: string }) {
  const [variant] = useState(() => resolveSyncIconVariant(getSyncIconPreference()));
  return <SyncingMissionControlIcon variant={variant} className={className} />;
}

export function NavRail({
  features,
  isAiActive,
  isSyncing = false,
  counts = EMPTY_NAVIGATION_COUNTS,
  syncStatus = [],
}: NavRailProps) {
  const pathname = usePathname();
  const { pinned, togglePinned } = useNavRailPrefs();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const { preferences } = useNavigationBadgePreferences();
  const [syncPopoverOpen, setSyncPopoverOpen] = useState(false);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPopoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPopoverHovered = useRef(false);
  const clickSuppressUntil = useRef(0);

  const expanded = pinned || hovered || focused || projectMenuOpen;
  const brandSubtitle = isAiActive ? 'Houston: working' : 'Houston: standing by';
  const activeSyncStatus = syncStatus.filter((status) => status.status !== 'disabled');
  const showSyncStatusControl = isSyncing || activeSyncStatus.length > 0;

  const handleMouseEnter = useCallback(() => {
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }

    const delay = Math.max(300, clickSuppressUntil.current - Date.now());
    expandTimer.current = setTimeout(() => setHovered(true), delay);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (expandTimer.current) {
      clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }

    collapseTimer.current = setTimeout(() => setHovered(false), 200);
  }, []);

  const handlePointerDownCapture = useCallback(() => {
    clickSuppressUntil.current = Date.now() + 800;
    if (expandTimer.current) {
      clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
  }, []);

  const openSyncPopover = useCallback(() => {
    syncPopoverHovered.current = true;
    if (syncPopoverCloseTimer.current) {
      clearTimeout(syncPopoverCloseTimer.current);
      syncPopoverCloseTimer.current = null;
    }
    setSyncPopoverOpen(true);
  }, []);

  const closeSyncPopoverAfterDelay = useCallback(() => {
    syncPopoverHovered.current = false;
    if (syncPopoverCloseTimer.current) {
      clearTimeout(syncPopoverCloseTimer.current);
    }
    syncPopoverCloseTimer.current = setTimeout(() => {
      setSyncPopoverOpen(false);
      syncPopoverCloseTimer.current = null;
    }, 100);
  }, []);

  useEffect(() => () => {
    if (expandTimer.current) clearTimeout(expandTimer.current);
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    if (syncPopoverCloseTimer.current) clearTimeout(syncPopoverCloseTimer.current);
  }, []);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  const isVisible = (item: NavRailItem) => {
    if (item.requiresFeature === 'aiEnabled' && features && !features.aiEnabled) return false;
    if (item.requiresFeature === 'financeEnabled' && features?.financeEnabled === false) return false;
    return true;
  };

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        'hidden sm:flex flex-col flex-shrink-0 bg-[var(--surface-1)] border-r border-[var(--border)] overflow-y-auto overflow-x-hidden transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
        expanded ? 'w-[200px]' : 'w-16'
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDownCapture={handlePointerDownCapture}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        const nextFocus = event.relatedTarget;
        if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
          setFocused(false);
        }
      }}
    >
      {/* Brand */}
      <div className="flex items-center flex-shrink-0 h-[58px] border-b border-[var(--border)]">
        <span className="w-16 flex items-center justify-center flex-shrink-0">
          {isSyncing ? (
            <ActiveSyncIcon className="drop-shadow-[0_0_6px_rgba(168,85,247,0.22)]" />
          ) : (
            <MissionControlIcon className="drop-shadow-[0_0_6px_rgba(168,85,247,0.22)]" />
          )}
        </span>
        <span className={cn(
          '-ml-1.5 flex flex-col justify-center whitespace-nowrap overflow-hidden transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
          expanded ? 'opacity-100 max-w-[128px]' : 'opacity-0 max-w-0'
        )}>
          <span className="text-[14px] leading-4 font-bold tracking-[-0.015em] text-[var(--text-primary)]">
            Mission Control
          </span>
          <span
            className="font-mono text-[9px] leading-3 tracking-[0.06em]"
            style={{ color: isAiActive ? BRAND_GRADIENT_END : BRAND_GRADIENT_START }}
          >
            {brandSubtitle}
          </span>
        </span>
      </div>

      {/* Nav groups */}
      <div className="flex-1 flex flex-col py-2 gap-0.5">
        {navGroups.map((group, groupIdx) => (
            <div key={group.label} role="group" aria-label={group.label}>
              {groupIdx > 0 && (
                <div className="h-px bg-[var(--text-tertiary)]/20 my-2.5 mx-3" />
              )}
              {group.items.filter(isVisible).map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                if (item.href === '/projects') {
                  return (
                    <RecentProjectsNavItem
                      key={item.href}
                      active={active}
                      expanded={expanded}
                      icon={Icon}
                      iconColor={item.iconColor}
                      open={projectMenuOpen}
                      pathname={pathname}
                      onOpenChange={setProjectMenuOpen}
                    />
                  );
                }
                const badgeCount = item.badgeKey ? counts[item.badgeKey] : 0;
                const badgeTone = item.badgeKey === 'notifications'
                  ? counts.notificationTone
                  : item.badgeTone;
                const pulseBadge = item.badgeKey === 'notifications'
                  && counts.notificationTone === 'red';
                return (
                  <Tooltip key={item.href} content={item.label} placement="right" disabled={expanded}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'relative flex items-center h-10 mx-2 px-2.5 gap-2.5 rounded-lg text-[13px] font-medium transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-1)]',
                        active
                          ? 'text-[var(--text-primary)] bg-[var(--surface-2)]'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                      )}
                    >
                      {/* Active indicator bar */}
                      {active && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-sm bg-[var(--accent)]" />
                      )}
                      <span className="relative w-[22px] h-[22px] flex items-center justify-center flex-shrink-0">
                        <Icon size={item.iconSize ?? 22} className={cn('flex-shrink-0', item.iconColor && (active ? item.iconColor.replace('400', '300') : item.iconColor))} />
                      </span>
                      <span className={cn(
                        'whitespace-nowrap overflow-hidden text-ellipsis transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                        expanded ? 'opacity-100 max-w-[150px]' : 'opacity-0 max-w-0'
                      )}>
                        {item.label}
                      </span>
                      {preferences.enabled && item.badgeKey && preferences.items[item.badgeKey] && badgeTone && (
                        <NavigationRailMorph
                          count={badgeCount}
                          tone={badgeTone}
                          expanded={expanded}
                          pulse={pulseBadge}
                          morphId={item.badgeKey}
                        />
                      )}
                      {item.href === '/ai' && isAiActive && (
                        <span className={cn(
                          'w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0',
                          expanded ? 'ml-auto' : 'absolute -top-0.5 -right-0.5'
                        )} />
                      )}
                    </Link>
                  </Tooltip>
                );
              })}
            </div>
          ))}
      </div>

      {/* Bottom section: pin toggle + settings */}
      <div className="flex flex-col gap-0.5 pb-2 mt-auto">
        <div className="h-px bg-[var(--text-tertiary)]/20 mb-2.5 mx-3" />

        {showSyncStatusControl && (
          <Popover.Root open={syncPopoverOpen} onOpenChange={setSyncPopoverOpen}>
            <div
              className="mx-2"
              onMouseEnter={openSyncPopover}
              onMouseLeave={closeSyncPopoverAfterDelay}
            >
              <Tooltip content="Sync status" placement="right" disabled={expanded || syncPopoverOpen}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    aria-label="Sync status"
                    onClick={(event) => {
                      if (syncPopoverHovered.current) event.preventDefault();
                    }}
                    className="w-full flex items-center h-10 px-2.5 gap-2.5 rounded-lg text-[13px] font-medium transition-colors duration-200 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
                  >
                    <span className="w-[22px] h-[22px] flex items-center justify-center flex-shrink-0">
                      <RefreshCw size={18} className={cn(isSyncing && 'animate-spin text-blue-400')} />
                    </span>
                    <span className={cn(
                      'whitespace-nowrap overflow-hidden text-ellipsis transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                      expanded ? 'opacity-100 max-w-[150px]' : 'opacity-0 max-w-0'
                    )}>
                      {isSyncing ? 'Syncing…' : 'Sync status'}
                    </span>
                  </button>
                </Popover.Trigger>
              </Tooltip>
            </div>

            <Popover.Portal>
              <Popover.Content
                side="right"
                align="end"
                sideOffset={10}
                collisionPadding={12}
                aria-label="Sync status details"
                className="z-50 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 shadow-2xl"
                onMouseEnter={openSyncPopover}
                onMouseLeave={closeSyncPopoverAfterDelay}
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Sync Status</h3>
                  {isSyncing && (
                    <span className="flex items-center gap-1 text-xs text-blue-400">
                      <RefreshCw size={10} className="animate-spin" />
                      Syncing…
                    </span>
                  )}
                </div>
                <div className="space-y-2 max-h-56 overflow-y-auto">
                  {activeSyncStatus.map((status) => {
                    const isHealthy = status.status === 'healthy';
                    return (
                      <div key={status.id} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {CONNECTOR_ICONS[status.type] && (
                            <Image src={CONNECTOR_ICONS[status.type]} alt={status.name} width={12} height={12} />
                          )}
                          <span className="text-[var(--text-secondary)] truncate">{status.name}</span>
                        </div>
                        {status.lastSyncAt ? (
                          <span className={cn('flex items-center gap-1', isHealthy ? 'text-green-400' : 'text-amber-400')}>
                            {isHealthy ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
                            <span>{formatSyncTime(status.lastSyncAt)}</span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-[var(--text-muted)]">
                            <AlertCircle size={10} />
                            <span>Never</span>
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {activeSyncStatus.length === 0 && (
                    <p className="text-xs text-[var(--text-muted)]">No active connectors.</p>
                  )}
                </div>
                <Popover.Arrow className="fill-[var(--border)]" />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}

        {/* Pin toggle */}
        <Tooltip content={pinned ? 'Unpin sidebar' : 'Pin sidebar'} placement="right" disabled={expanded}>
          <button
            onClick={togglePinned}
            aria-label={pinned ? 'Unpin navigation' : 'Pin navigation open'}
            className={cn(
              'flex items-center h-10 mx-2 px-2.5 gap-2.5 rounded-lg text-[13px] font-medium transition-colors duration-200 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
              pinned && 'text-[var(--accent-400)]'
            )}
          >
            <span className="w-[22px] h-[22px] flex items-center justify-center flex-shrink-0">
              {pinned ? <PinOff size={20} /> : <Pin size={20} />}
            </span>
            <span className={cn(
              'whitespace-nowrap overflow-hidden text-ellipsis transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
              expanded ? 'opacity-100 max-w-[150px]' : 'opacity-0 max-w-0'
            )}>
              {pinned ? 'Unpin sidebar' : 'Pin sidebar'}
            </span>
          </button>
        </Tooltip>

        {/* Bottom nav items (Settings) */}
        {bottomItems.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          return (
            <Tooltip key={item.href} content={item.label} placement="right" disabled={expanded}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex items-center h-10 mx-2 px-2.5 gap-2.5 rounded-lg text-[13px] font-medium transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                  active
                    ? 'text-[var(--text-primary)] bg-[var(--surface-2)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-sm bg-[var(--accent)]" />
                )}
                <span className="w-[22px] h-[22px] flex items-center justify-center flex-shrink-0">
                  <Icon size={item.iconSize ?? 22} className={cn('flex-shrink-0', item.iconColor && (active ? item.iconColor.replace('400', '300') : item.iconColor))} />
                </span>
                <span className={cn(
                  'whitespace-nowrap overflow-hidden text-ellipsis transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                  expanded ? 'opacity-100 max-w-[150px]' : 'opacity-0 max-w-0'
                )}>
                  {item.label}
                </span>
              </Link>
            </Tooltip>
          );
        })}
      </div>
    </nav>
  );
}
