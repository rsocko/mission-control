'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Tooltip } from '@/components/ui/Tooltip';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import { MissionControlIcon } from '@/components/ui/MissionControlIcon';
import { SyncingMissionControlIcon } from '@/components/ui/SyncingMissionControlIcon';
import { Popover } from '@/components/ui/Popover';
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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNavRailPrefs } from '@/lib/hooks/useNavRailPrefs';
import {
  getSyncIconPreference,
  resolveSyncIconVariant,
} from '@/lib/hooks/useSyncIconPreference';
import { CONNECTOR_ICONS } from '@/types/dashboard';
import type { ConnectorHealthInfo } from '@/lib/hooks/useSystemHealth';

import type { ComponentType } from 'react';

interface NavRailItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconColor?: string;
  iconSize?: number;
  requiresFeature?: 'aiEnabled' | 'financeEnabled';
}

interface NavRailGroup {
  label: string;
  items: NavRailItem[];
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
      { href: '/', label: 'Dashboard', icon: LayoutDashboard, iconColor: 'text-blue-400' },
      { href: '/today', label: 'My Day', icon: Sun, iconColor: 'text-amber-400' },
      { href: '/projects', label: 'Projects', icon: ChartNetwork, iconColor: 'text-violet-400' },
      { href: '/kanban', label: 'Kanban', icon: Columns3, iconColor: 'text-cyan-400' },
      { href: '/goals', label: 'Goals', icon: Target, iconColor: 'text-rose-400' },
      { href: '/timeline', label: 'Timeline', icon: CalendarDays, iconColor: 'text-sky-400' },
    ],
  },
  {
    label: 'Operate',
    items: [
      { href: '/notifications', label: 'Notifications', icon: Bell, iconColor: 'text-yellow-400' },
      { href: '/routines', label: 'Routines', icon: Repeat, iconColor: 'text-emerald-400' },
      { href: '/triage', label: 'Triage', icon: Inbox, iconColor: 'text-purple-400' },
      { href: '/quick-sort', label: 'Quick Sort', icon: Zap, iconColor: 'text-amber-400' },
      { href: '/scout/reconciliation', label: 'Reconciliation', icon: ShieldCheck, iconColor: 'text-emerald-400' },
    ],
  },
  {
    label: 'Understand',
    items: [
      { href: '/insights', label: 'Insights', icon: Activity, iconColor: 'text-pink-400' },
      { href: '/graph', label: 'Graph', icon: PhosphorGraphIcon, iconColor: 'text-indigo-400' },
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
      { href: '/ai', label: 'Houston', icon: HoustonIcon, iconSize: 26, requiresFeature: 'aiEnabled' },
    ],
  },
];

const bottomItems: NavRailItem[] = [
  { href: '/settings', label: 'Settings', icon: Settings, iconColor: 'text-slate-400' },
];

interface NavRailProps {
  features: { aiEnabled: boolean; financeEnabled?: boolean } | null;
  isAiActive: boolean;
  isSyncing?: boolean;
  syncStatus?: ConnectorHealthInfo[];
}

function ActiveSyncIcon({ className }: { className?: string }) {
  const [variant] = useState(() => resolveSyncIconVariant(getSyncIconPreference()));
  return <SyncingMissionControlIcon variant={variant} className={className} />;
}

export function NavRail({ features, isAiActive, isSyncing = false, syncStatus = [] }: NavRailProps) {
  const pathname = usePathname();
  const { pinned, togglePinned } = useNavRailPrefs();
  const [hovered, setHovered] = useState(false);
  const [syncPopoverOpen, setSyncPopoverOpen] = useState(false);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickSuppressUntil = useRef(0);

  const expanded = pinned || hovered;
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

  useEffect(() => () => {
    if (expandTimer.current) clearTimeout(expandTimer.current);
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
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
                    <span className="w-[22px] h-[22px] flex items-center justify-center flex-shrink-0">
                      <Icon size={item.iconSize ?? 22} className={cn('flex-shrink-0', item.iconColor && (active ? item.iconColor.replace('400', '300') : item.iconColor))} />
                    </span>
                    <span className={cn(
                      'whitespace-nowrap overflow-hidden text-ellipsis transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                      expanded ? 'opacity-100 max-w-[150px]' : 'opacity-0 max-w-0'
                    )}>
                      {item.label}
                    </span>
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
          <div className="relative mx-2">
            <Tooltip content="Sync status" placement="right" disabled={expanded || syncPopoverOpen}>
              <button
                type="button"
                onClick={() => setSyncPopoverOpen((current) => !current)}
                aria-label="Sync status"
                aria-expanded={syncPopoverOpen}
                className="w-full flex items-center h-10 px-2.5 gap-2.5 rounded-lg text-[13px] font-medium transition-colors duration-200 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
              >
                <span className="w-[22px] h-[22px] flex items-center justify-center flex-shrink-0">
                  <RefreshCw size={18} className={cn(isSyncing && 'animate-spin text-blue-400')} />
                </span>
                <span className={cn(
                  'whitespace-nowrap overflow-hidden text-ellipsis transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                  expanded ? 'opacity-100 max-w-[150px]' : 'opacity-0 max-w-0'
                )}>
                  Sync status
                </span>
              </button>
            </Tooltip>

            <Popover
              isOpen={syncPopoverOpen}
              onClose={() => setSyncPopoverOpen(false)}
              align={expanded ? 'left' : 'right'}
              width="w-72"
              className="p-3"
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
            </Popover>
          </div>
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
