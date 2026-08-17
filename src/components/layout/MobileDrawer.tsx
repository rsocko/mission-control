'use client';

import { useEffect, useCallback, useState, useRef, type RefObject } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  LayoutDashboard,
  ChartNetwork,
  Target,
  Bell,
  Repeat,
  Activity,
  Settings,
  Search,
  RefreshCw,
  User,
  ListChecks,
  Orbit,
  ShieldCheck,
  Coins,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { drawerSlideIn, drawerOverlay } from '@/lib/motion';
import { NavigationBadge } from '@/components/layout/NavigationBadge';
import { useNavigationBadgePreferences } from '@/lib/hooks/useNavigationBadges';
import {
  EMPTY_NAVIGATION_COUNTS,
  type NavBadgeKey,
  type NavBadgeTone,
  type NavigationCounts,
} from '@/lib/navigation/badges';

interface DrawerNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  iconColor: string;
  requiresFeature?: 'financeEnabled';
  badgeKey?: NavBadgeKey;
  badgeTone?: NavBadgeTone;
}

const drawerNavItems: DrawerNavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, iconColor: 'text-blue-400' },
  { href: '/all-tasks', label: 'All Tasks', icon: ListChecks, iconColor: 'text-cyan-400' },
  { href: '/projects', label: 'Projects', icon: ChartNetwork, iconColor: 'text-violet-400' },
  { href: '/graph', label: 'Graph', icon: Orbit, iconColor: 'text-indigo-400' },
  { href: '/goals', label: 'Goals', icon: Target, iconColor: 'text-rose-400' },
  { href: '/notifications', label: 'Notifications', icon: Bell, iconColor: 'text-yellow-400', badgeKey: 'notifications', badgeTone: 'blue' },
  { href: '/scout/reconciliation', label: 'Reconciliation', icon: ShieldCheck, iconColor: 'text-emerald-400', badgeKey: 'reconciliation', badgeTone: 'amber' },
  { href: '/routines', label: 'Routines', icon: Repeat, iconColor: 'text-emerald-400' },
  { href: '/insights', label: 'Insights', icon: Activity, iconColor: 'text-pink-400' },
  { href: '/finance', label: 'Money', icon: Coins, iconColor: 'text-amber-400', requiresFeature: 'financeEnabled' },
  { href: '/settings', label: 'Settings', icon: Settings, iconColor: 'text-slate-400' },
];

export interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  features?: { financeEnabled?: boolean } | null;
  counts?: NavigationCounts;
}

export function MobileDrawer({
  isOpen,
  onClose,
  returnFocusRef,
  features,
  counts = EMPTY_NAVIGATION_COUNTS,
}: MobileDrawerProps) {
  const pathname = usePathname();
  const { progress } = useSyncStream();
  const [searchQuery, setSearchQuery] = useState('');
  const drawerRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasOpenedRef = useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const { preferences } = useNavigationBadgePreferences();

  useEffect(() => {
    if (isOpen) hasOpenedRef.current = true;
  }, [isOpen]);

  const handleExitComplete = useCallback(() => {
    if (!hasOpenedRef.current || isOpen) return;
    hasOpenedRef.current = false;
    returnFocusRef.current?.focus();
  }, [isOpen, returnFocusRef]);

  const handleDrawerAnimationComplete = useCallback((definition: unknown) => {
    if (definition === 'show') searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Focus trap: contain Tab within drawer without opening the mobile keyboard
  useEffect(() => {
    if (!isOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    drawer.focus();

    function handleTab(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !drawer) return;
      const focusable = drawer.querySelectorAll<HTMLElement>(
        'a[href], button, input, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (document.activeElement === drawer) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleTab);
    return () => document.removeEventListener('keydown', handleTab);
  }, [isOpen]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isOpen]);

  // Close when navigating (skip the initial mount)
  const isInitialRender = useRef(true);
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    if (isOpen) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      // Dispatch a custom event that SearchCommand can listen for,
      // or navigate to a search page
      window.dispatchEvent(new CustomEvent('mission-control:open-search', { detail: { query: searchQuery.trim() } }));
      setSearchQuery('');
      onClose();
    }
  }, [searchQuery, onClose]);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <AnimatePresence onExitComplete={handleExitComplete}>
      {isOpen && (
        <div
          id="mobile-navigation-drawer"
          className="fixed inset-0 z-50 sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          {/* Overlay */}
          <motion.div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            variants={drawerOverlay}
            initial="hidden"
            animate="show"
            exit="exit"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Drawer panel */}
          <motion.nav
            ref={drawerRef}
            tabIndex={-1}
            className="absolute top-0 left-0 bottom-0 w-[280px] bg-[var(--surface-1)] border-r border-[var(--border)] flex flex-col safe-area-pt safe-area-pb"
            variants={drawerSlideIn}
            initial="hidden"
            animate="show"
            exit="exit"
            onAnimationComplete={handleDrawerAnimationComplete}
            aria-label="Drawer navigation"
          >
            {/* User avatar + name */}
            <div className="flex items-center gap-3 px-5 pt-4 pb-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[var(--accent)] to-indigo-500 flex items-center justify-center flex-shrink-0 shadow-sm">
                <User size={20} className="text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)] truncate">Mission Control</p>
                <p className="text-xs text-[var(--text-tertiary)]">Personal workspace</p>
              </div>
            </div>

            {/* Search bar */}
            <div className="px-4 pb-3">
              <form onSubmit={handleSearchSubmit}>
                <div className="input-glow flex items-center gap-2 h-9 px-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
                  <Search size={14} className="text-[var(--text-tertiary)] flex-shrink-0" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search…"
                    className="flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                    aria-label="Search"
                  />
                </div>
              </form>
            </div>

            {/* Separator */}
            <div className="h-px bg-[var(--border)] mx-4" />

            {/* Navigation items */}
            <div className="flex-1 overflow-y-auto py-2 px-2">
              {drawerNavItems.filter((item) => (
                item.requiresFeature !== 'financeEnabled' || features?.financeEnabled !== false
              )).map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                const badgeCount = item.badgeKey ? counts[item.badgeKey] : 0;
                const badgeTone = item.badgeKey === 'notifications'
                  ? counts.notificationTone
                  : item.badgeTone;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 h-11 px-3 rounded-lg text-sm font-medium transition-colors min-h-[44px]',
                      active
                        ? 'text-[var(--text-primary)] bg-[var(--surface-2)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                    )}
                  >
                    {active && (
                      <span className="absolute left-0 w-[3px] h-5 rounded-r-sm bg-[var(--accent)]" />
                    )}
                    <Icon size={20} className={cn('flex-shrink-0', active ? item.iconColor.replace('400', '300') : item.iconColor)} />
                    <span>{item.label}</span>
                    {preferences.enabled && item.badgeKey && preferences.items[item.badgeKey] && badgeTone && (
                      <span className="ml-auto">
                        <NavigationBadge count={badgeCount} tone={badgeTone} />
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>

            {/* Sync status at bottom */}
            <div className="border-t border-[var(--border)] px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                {progress.isSyncing ? (
                  <>
                    <motion.div
                      animate={prefersReducedMotion ? undefined : { rotate: 360 }}
                      transition={prefersReducedMotion ? { duration: 0 } : { duration: 1.5, repeat: Infinity, ease: 'linear' }}
                    >
                      <RefreshCw size={12} className="text-[var(--accent-400)]" />
                    </motion.div>
                    <span className="truncate">
                      Syncing{progress.connectorName ? ` ${progress.connectorName}` : ''}…
                    </span>
                  </>
                ) : (
                  <>
                    <span className="w-2 h-2 rounded-full bg-[var(--success)] flex-shrink-0" />
                    <span>All synced</span>
                  </>
                )}
              </div>
            </div>
          </motion.nav>
        </div>
      )}
    </AnimatePresence>
  );
}
