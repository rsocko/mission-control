'use client';

import { useCallback, useEffect, useState, type Ref } from 'react';
import { Menu, Search, WifiOff, Cloud } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOnlineStatus } from '@/lib/hooks/useOnlineStatus';
import { useOfflineQueue } from '@/lib/hooks/useOfflineQueue';

export interface MobileHeaderProps {
  /** Screen title displayed in center */
  title: string;
  /** Whether the search icon is shown (default: true) */
  showSearch?: boolean;
  /** Optional context action rendered on the right side */
  contextAction?: React.ReactNode;
  /** Callback to open the drawer */
  onMenuPress: () => void;
  /** Ref used by the drawer to return focus after closing */
  menuButtonRef?: Ref<HTMLButtonElement>;
  /** Whether the drawer is currently open (for aria-expanded) */
  isDrawerOpen?: boolean;
  /** Callback when search icon is tapped */
  onSearchPress?: () => void;
}

/**
 * Hook that polls the notifications API for unread notification severity levels.
 * Returns the color for the hamburger dot based on the most severe unread notification:
 * - 'red' for urgent
 * - 'orange' for action_needed
 * - 'amber' for heads_up
 * - null if only fyi/digest (no dot shown)
 * Only polls on mobile viewports.
 */
export type NotificationDotColor = 'red' | 'orange' | 'amber' | null;

export function useNotificationDotColor(): NotificationDotColor {
  const [dotColor, setDotColor] = useState<NotificationDotColor>(null);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 639px)');
    if (!mql.matches) return;

    let abortController: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    async function fetchNotificationStatus() {
      abortController = new AbortController();
      try {
        const res = await fetch('/api/notifications?limit=0', { signal: abortController.signal });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          const urgent = data?.stats?.urgent ?? 0;
          const actionNeeded = data?.stats?.actionNeeded ?? 0;
          const headsUp = data?.stats?.headsUp ?? 0;

          if (urgent > 0) {
            setDotColor('red');
          } else if (actionNeeded > 0) {
            setDotColor('orange');
          } else if (headsUp > 0) {
            setDotColor('amber');
          } else {
            setDotColor(null);
          }
        }
      } catch {
        // Ignore abort and network errors
      }
      if (!cancelled) {
        timer = setTimeout(fetchNotificationStatus, 60_000);
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        if (timer) { clearTimeout(timer); timer = null; }
        abortController?.abort();
      } else {
        void fetchNotificationStatus();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void fetchNotificationStatus();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      abortController?.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return dotColor;
}

/**
 * Standardized mobile header component.
 * Pattern: [Hamburger + notification dot] [Screen Title] [Search icon] [Context action]
 *
 * Covers:
 * - F-8: Hamburger icon top-left on all screens
 * - F-9: Notification dot indicator on hamburger icon
 */
export function MobileHeader({
  title,
  showSearch = true,
  contextAction,
  onMenuPress,
  menuButtonRef,
  isDrawerOpen = false,
  onSearchPress,
}: MobileHeaderProps) {
  const dotColor = useNotificationDotColor();
  const isOnline = useOnlineStatus();
  const { totalPendingCount } = useOfflineQueue();

  const handleSearchClick = useCallback(() => {
    if (onSearchPress) {
      onSearchPress();
    } else {
      window.dispatchEvent(new CustomEvent('mission-control:open-search'));
    }
  }, [onSearchPress]);

  const dotColorClass = dotColor === 'red'
    ? 'bg-red-500'
    : dotColor === 'orange'
      ? 'bg-orange-500'
      : dotColor === 'amber'
        ? 'bg-amber-400'
        : '';

  return (
    <header className="flex flex-col sm:hidden">
      <div className="flex items-center h-12 px-3 bg-[var(--surface-0)] border-b border-[var(--border-subtle)]">
        {/* Hamburger button with notification dot */}
        <button
          ref={menuButtonRef}
          onClick={onMenuPress}
          className="relative flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          aria-label={dotColor ? 'Open menu (has notifications)' : 'Open menu'}
          aria-expanded={isDrawerOpen}
          aria-controls="mobile-navigation-drawer"
        >
          <Menu size={20} />
          {/* Notification dot indicator (F-9) — colored by most severe level */}
          {dotColor && (
            <span
              className={cn('absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-[var(--surface-0)]', dotColorClass)}
              aria-hidden="true"
            />
          )}
        </button>

        {/* Screen title */}
        <h1 className="flex-1 text-center text-sm font-semibold text-[var(--text-primary)] truncate px-2">
          {title}
        </h1>

        {/* Right side: search + context action */}
        <div className="flex items-center gap-0.5">
          {showSearch && (
            <button
              onClick={handleSearchClick}
              className="flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
              aria-label="Search"
            >
              <Search size={18} />
            </button>
          )}
          {contextAction && (
            <div className="flex items-center">{contextAction}</div>
          )}
          {/* Spacer to balance the hamburger when no actions on right */}
          {!showSearch && !contextAction && <div className="w-11" />}
        </div>
      </div>

      {/* Offline indicator banner (#1529) */}
      <OfflineBanner isOnline={isOnline} pendingCount={totalPendingCount} />
    </header>
  );
}

// ─── Offline Banner ──────────────────────────────────────────────────────────

interface OfflineBannerProps {
  isOnline: boolean;
  pendingCount: number;
}

/**
 * Subtle banner shown when the device is offline or has pending mutations.
 * Animates in/out with CSS transitions. Shows pending count when > 0.
 */
function OfflineBanner({ isOnline, pendingCount }: OfflineBannerProps) {
  // Track whether we've ever gone offline to avoid showing the "back online"
  // banner on initial mount.
  const [hasBeenOffline, setHasBeenOffline] = useState(false);
  // Show "back online" briefly when reconnecting
  const [showReconnected, setShowReconnected] = useState(false);

  useEffect(() => {
    if (!isOnline) {
      setHasBeenOffline(true);
      setShowReconnected(false);
    } else if (hasBeenOffline) {
      setShowReconnected(true);
      const timer = setTimeout(() => setShowReconnected(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isOnline, hasBeenOffline]);

  // Nothing to show if online with no pending actions and no recent reconnect
  if (isOnline && !showReconnected && pendingCount === 0) return null;

  const isOffline = !isOnline;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-all duration-300 ease-out',
        isOffline
          ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border-b border-amber-200 dark:border-amber-800'
          : showReconnected
            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 border-b border-emerald-200 dark:border-emerald-800'
            : 'bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200 border-b border-blue-200 dark:border-blue-800',
      )}
    >
      {isOffline ? (
        <>
          <WifiOff size={14} className="shrink-0 animate-pulse" />
          <span>
            You&apos;re offline
            {pendingCount > 0 && (
              <> &middot; {pendingCount} pending {pendingCount === 1 ? 'action' : 'actions'}</>
            )}
          </span>
        </>
      ) : showReconnected ? (
        <>
          <Cloud size={14} className="shrink-0" />
          <span>
            Back online
            {pendingCount > 0 && (
              <> &middot; syncing {pendingCount} {pendingCount === 1 ? 'action' : 'actions'}&hellip;</>
            )}
          </span>
        </>
      ) : (
        <>
          <Cloud size={14} className="shrink-0 animate-pulse" />
          <span>Syncing {pendingCount} pending {pendingCount === 1 ? 'action' : 'actions'}&hellip;</span>
        </>
      )}
    </div>
  );
}
