'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  ListChecks,
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
import {
  AdaptiveNavGroup,
  type AdaptiveNavItem,
} from '@/components/layout/AdaptiveNavGroup';

import {
  NavigationRailMorph,
} from '@/components/layout/NavigationBadge';
import { useNavigationBadgePreferences } from '@/lib/hooks/useNavigationBadges';
import {
  EMPTY_NAVIGATION_COUNTS,
  type NavigationCounts,
} from '@/lib/navigation/badges';

type NavRailItem = AdaptiveNavItem;

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

const planCoreItems: NavRailItem[] = [
  shortcutNavItem('/', LayoutDashboard),
  { href: '/all-tasks', label: 'All Tasks', icon: ListChecks, iconColor: 'text-cyan-400' },
  shortcutNavItem('/today', Sun, { badgeKey: 'myDay', badgeTone: 'amber' }),
  shortcutNavItem('/projects', ChartNetwork),
];

const planningItems: NavRailItem[] = [
  shortcutNavItem('/kanban', Columns3),
  shortcutNavItem('/goals', Target),
  shortcutNavItem('/timeline', CalendarDays),
];

const notificationItem = shortcutNavItem('/notifications', Bell, {
  badgeKey: 'notifications',
  badgeTone: 'blue',
});
const routinesItem = shortcutNavItem('/routines', Repeat);
const triageItem = shortcutNavItem('/triage', Inbox, {
  badgeKey: 'triage',
  badgeTone: 'red',
});
const quickSortItem = shortcutNavItem('/quick-sort', Zap, {
  badgeKey: 'quickSort',
  badgeTone: 'amber',
});
const reconciliationItem: NavRailItem = {
  href: '/scout/reconciliation',
  label: 'Reconciliation',
  icon: ShieldCheck,
  iconColor: 'text-emerald-400',
  badgeKey: 'reconciliation',
  badgeTone: 'amber',
};
const operationsItems = [routinesItem, triageItem, reconciliationItem];

const exploreItems: NavRailItem[] = [
  shortcutNavItem('/insights', Activity),
  { href: '/graph', label: 'Graph', icon: PhosphorGraphIcon, iconColor: 'text-indigo-400' },
];

const domainItems: NavRailItem[] = [
  { href: '/doc-intelligence', label: 'Docs', icon: FileText, iconColor: 'text-orange-400' },
  { href: '/finance', label: 'Money', icon: Coins, iconColor: 'text-amber-400', requiresFeature: 'financeEnabled' },
];

const assistantItems: NavRailItem[] = [
  shortcutNavItem('/ai', HoustonIcon, { iconSize: 26, requiresFeature: 'aiEnabled' }),
];

const COLLAPSE_PRIORITY = ['system', 'operations', 'explore', 'planning', 'domains'] as const;
type AdaptiveGroupKey = (typeof COLLAPSE_PRIORITY)[number];
const NAV_HEIGHT_BUFFER = 12;

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
  const [groupMenuOpen, setGroupMenuOpen] = useState<AdaptiveGroupKey | null>(null);
  const { preferences } = useNavigationBadgePreferences();
  const [syncPopoverOpen, setSyncPopoverOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const lastNavHeight = useRef<number | null>(null);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPopoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPopoverHovered = useRef(false);
  const clickSuppressUntil = useRef(0);
  const pointerDown = useRef(false);
  const pointerFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expanded = pinned
    || hovered
    || focused
    || projectMenuOpen
    || groupMenuOpen !== null
    || syncPopoverOpen;
  const brandSubtitle = isAiActive ? 'Houston: working' : 'Houston: standing by';
  const activeSyncStatus = syncStatus.filter((status) => status.status !== 'disabled');
  const showSyncStatusControl = isSyncing || activeSyncStatus.length > 0;
  const layoutSignature = [
    features?.aiEnabled,
    features?.financeEnabled,
    showSyncStatusControl,
  ].join(':');
  const [adaptiveLayout, setAdaptiveLayout] = useState(() => ({
    signature: layoutSignature,
    level: 0,
  }));
  const collapseLevel = adaptiveLayout.signature === layoutSignature
    ? adaptiveLayout.level
    : 0;

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
    pointerDown.current = true;
    setFocused(false);
    if (pointerFocusTimer.current) clearTimeout(pointerFocusTimer.current);
    pointerFocusTimer.current = setTimeout(() => {
      pointerDown.current = false;
      pointerFocusTimer.current = null;
    }, 0);
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
    if (pointerFocusTimer.current) clearTimeout(pointerFocusTimer.current);
  }, []);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.contentRect.height ?? nav.getBoundingClientRect().height;
      if (height <= 0 || height === lastNavHeight.current) return;
      lastNavHeight.current = height;
      setAdaptiveLayout({ signature: layoutSignature, level: 0 });
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [layoutSignature]);

  useLayoutEffect(() => {
    const scrollRegion = scrollRegionRef.current;
    const scrollContent = scrollContentRef.current;
    if (
      !scrollRegion
      || !scrollContent
      || scrollRegion.clientHeight <= 0
      || collapseLevel >= COLLAPSE_PRIORITY.length
    ) return;

    if (scrollContent.scrollHeight + NAV_HEIGHT_BUFFER > scrollRegion.clientHeight) {
      setAdaptiveLayout({
        signature: layoutSignature,
        level: Math.min(collapseLevel + 1, COLLAPSE_PRIORITY.length),
      });
    }
  }, [collapseLevel, layoutSignature]);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  const isVisible = (item: NavRailItem) => {
    if (item.requiresFeature === 'aiEnabled' && features && !features.aiEnabled) return false;
    if (item.requiresFeature === 'financeEnabled' && features?.financeEnabled === false) return false;
    return true;
  };
  const visibleDomainItems = domainItems.filter(isVisible);
  const isGroupCollapsed = (group: AdaptiveGroupKey) => {
    if (collapseLevel <= COLLAPSE_PRIORITY.indexOf(group)) return false;
    if (group === 'system') return showSyncStatusControl;
    if (group === 'domains') return visibleDomainItems.length > 1;
    return true;
  };

  const renderNavItem = (item: NavRailItem) => {
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
            'relative mx-2 flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-1)]',
            active
              ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
          )}
        >
          {active && (
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-sm bg-[var(--accent)]" />
          )}
          <span className="relative flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center">
            <Icon
              size={item.iconSize ?? 22}
              className={cn(
                'flex-shrink-0',
                item.iconColor
                  && (active ? item.iconColor.replace('400', '300') : item.iconColor),
              )}
            />
          </span>
          <span
            className={cn(
              'overflow-hidden text-ellipsis whitespace-nowrap transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
              expanded ? 'max-w-[150px] opacity-100' : 'max-w-0 opacity-0',
            )}
          >
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
            <span
              className={cn(
                'h-2 w-2 flex-shrink-0 rounded-full bg-blue-400 animate-pulse',
                expanded ? 'ml-auto' : 'absolute -right-0.5 -top-0.5',
              )}
            />
          )}
        </Link>
      </Tooltip>
    );
  };

  const renderAdaptiveGroup = (
    key: Exclude<AdaptiveGroupKey, 'system'>,
    label: string,
    icon: typeof Settings,
    items: NavRailItem[],
  ) => {
    const visibleItems = items.filter(isVisible);
    return (
      <AdaptiveNavGroup
        key={key}
        groupKey={key}
        label={label}
        icon={icon}
        items={visibleItems}
        expanded={expanded}
        counts={counts}
        preferences={preferences}
        isActive={isActive}
        open={groupMenuOpen === key}
        onOpenChange={(open) => setGroupMenuOpen(open ? key : null)}
      />
    );
  };

  const syncStatusPopoverContent = (
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
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            Sync Status
          </h3>
          {isSyncing && (
            <span className="flex items-center gap-1 text-xs text-blue-400">
              <RefreshCw size={10} className="animate-spin" />
              Syncing…
            </span>
          )}
        </div>
        <div className="max-h-56 space-y-2 overflow-y-auto">
          {activeSyncStatus.map((status) => {
            const isHealthy = status.status === 'healthy';
            return (
              <div key={status.id} className="flex items-center justify-between text-xs">
                <div className="flex min-w-0 items-center gap-1.5">
                  {CONNECTOR_ICONS[status.type] && (
                    <Image
                      src={CONNECTOR_ICONS[status.type]}
                      alt={status.name}
                      width={12}
                      height={12}
                    />
                  )}
                  <span className="truncate text-[var(--text-secondary)]">{status.name}</span>
                </div>
                {status.lastSyncAt ? (
                  <span
                    className={cn(
                      'flex items-center gap-1',
                      isHealthy ? 'text-green-400' : 'text-amber-400',
                    )}
                  >
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
  );

  return (
    <nav
      ref={navRef}
      aria-label="Main navigation"
      className={cn(
        'hidden sm:flex flex-col flex-shrink-0 overflow-hidden bg-[var(--surface-1)] border-r border-[var(--border)] transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
        expanded ? 'w-[200px]' : 'w-16'
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDownCapture={handlePointerDownCapture}
      onFocusCapture={() => {
        if (!pointerDown.current) setFocused(true);
      }}
      onBlurCapture={(event) => {
        const nextFocus = event.relatedTarget;
        if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
          setFocused(false);
        }
      }}
    >
      {/* Brand */}
      <div className="relative flex items-center flex-shrink-0 h-[58px] border-b border-[var(--border)]">
        <span className="w-16 flex items-center justify-center flex-shrink-0">
          {isSyncing ? (
            <ActiveSyncIcon className="drop-shadow-[0_0_6px_rgba(168,85,247,0.22)]" />
          ) : (
            <MissionControlIcon className="drop-shadow-[0_0_6px_rgba(168,85,247,0.22)]" />
          )}
        </span>
        <span className={cn(
          '-ml-1.5 flex flex-col justify-center whitespace-nowrap overflow-hidden transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
          expanded ? 'opacity-100 max-w-[100px]' : 'opacity-0 max-w-0'
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
        <Tooltip content={pinned ? 'Unpin sidebar' : 'Pin sidebar'} placement="bottom">
          <button
            type="button"
            onClick={togglePinned}
            aria-label={pinned ? 'Unpin navigation' : 'Pin navigation open'}
            className={cn(
              'absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-muted)] transition-[color,background-color,opacity] duration-200 hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
              expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
              pinned && 'text-[var(--accent-400)]'
            )}
          >
            {pinned ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
        </Tooltip>
      </div>

      <div
        ref={scrollRegionRef}
        data-nav-scroll-region
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div
          ref={scrollContentRef}
          data-collapse-level={collapseLevel}
          data-collapsed-groups={COLLAPSE_PRIORITY.filter(isGroupCollapsed).join(' ')}
          className="flex flex-col gap-0.5 py-2"
        >
          <div role="group" aria-label="Plan">
            {planCoreItems.filter(isVisible).map(renderNavItem)}
            {isGroupCollapsed('planning')
              ? renderAdaptiveGroup('planning', 'Planning', Columns3, planningItems)
              : planningItems.filter(isVisible).map(renderNavItem)}
          </div>

          <div role="group" aria-label="Operate">
            <div className="mx-3 my-2.5 h-px bg-[var(--text-tertiary)]/20" />
            {renderNavItem(notificationItem)}
            {isGroupCollapsed('operations') ? (
              <>
                {renderNavItem(quickSortItem)}
                {renderAdaptiveGroup('operations', 'Operations', Repeat, operationsItems)}
              </>
            ) : (
              <>
                {renderNavItem(routinesItem)}
                {renderNavItem(triageItem)}
                {renderNavItem(quickSortItem)}
                {renderNavItem(reconciliationItem)}
              </>
            )}
          </div>

          <div role="group" aria-label="Explore">
            <div className="mx-3 my-2.5 h-px bg-[var(--text-tertiary)]/20" />
            {isGroupCollapsed('explore')
              ? renderAdaptiveGroup('explore', 'Explore', Activity, exploreItems)
              : exploreItems.filter(isVisible).map(renderNavItem)}
          </div>

          <div role="group" aria-label="Domains">
            <div className="mx-3 my-2.5 h-px bg-[var(--text-tertiary)]/20" />
            {isGroupCollapsed('domains')
              ? renderAdaptiveGroup('domains', 'Domains', FileText, visibleDomainItems)
              : visibleDomainItems.map(renderNavItem)}
          </div>

          <div role="group" aria-label="Assistant">
            <div className="mx-3 my-2.5 h-px bg-[var(--text-tertiary)]/20" />
            {assistantItems.filter(isVisible).map(renderNavItem)}
          </div>
        </div>
      </div>

      <div className="mt-auto flex flex-shrink-0 flex-col gap-0.5 pb-2">
        <div className="mx-3 mb-2.5 h-px bg-[var(--text-tertiary)]/20" />

        {isGroupCollapsed('system') && showSyncStatusControl ? (
          <Popover.Root open={syncPopoverOpen} onOpenChange={setSyncPopoverOpen}>
            <Popover.Anchor asChild>
              <div>
                <AdaptiveNavGroup
                  groupKey="system"
                  label="System"
                  icon={Settings}
                  items={bottomItems}
                  actions={[
                    {
                      label: 'Sync status',
                      icon: RefreshCw,
                      iconClassName: isSyncing ? 'animate-spin text-blue-400' : undefined,
                      onSelect: () => setSyncPopoverOpen(true),
                    },
                  ]}
                  expanded={expanded}
                  counts={counts}
                  preferences={preferences}
                  isActive={isActive}
                  open={groupMenuOpen === 'system'}
                  onOpenChange={(open) => setGroupMenuOpen(open ? 'system' : null)}
                />
              </div>
            </Popover.Anchor>
            {syncStatusPopoverContent}
          </Popover.Root>
        ) : (
          <>
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
                        className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors duration-200 hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                      >
                        <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center">
                          <RefreshCw
                            size={18}
                            className={cn(isSyncing && 'animate-spin text-blue-400')}
                          />
                        </span>
                        <span
                          className={cn(
                            'overflow-hidden text-ellipsis whitespace-nowrap transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                            expanded ? 'max-w-[150px] opacity-100' : 'max-w-0 opacity-0',
                          )}
                        >
                          {isSyncing ? 'Syncing…' : 'Sync status'}
                        </span>
                      </button>
                    </Popover.Trigger>
                  </Tooltip>
                </div>
                {syncStatusPopoverContent}
              </Popover.Root>
            )}
            {bottomItems.map(renderNavItem)}
          </>
        )}
      </div>
    </nav>
  );
}
