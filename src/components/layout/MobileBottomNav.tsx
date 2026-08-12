'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useRef, useCallback, useSyncExternalStore } from 'react';
import { Sun, Layers, PlusCircle, Zap, Mic, Square } from 'lucide-react';
import { toast } from 'sonner';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import { useVoiceCapture } from '@/lib/hooks/useVoiceCapture';
import { cn } from '@/lib/utils';

// --- Nav badge visibility setting (persisted in localStorage) ---

const NAV_BADGE_KEY = 'mission-control:nav-badges-visible';

const navBadgeListeners = new Set<() => void>();

function getNavBadgeSnapshot(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(NAV_BADGE_KEY) !== 'false';
}

function subscribeNavBadge(callback: () => void) {
  navBadgeListeners.add(callback);
  return () => { navBadgeListeners.delete(callback); };
}

export function setNavBadgesVisible(visible: boolean) {
  localStorage.setItem(NAV_BADGE_KEY, String(visible));
  navBadgeListeners.forEach((cb) => cb());
}

export function useNavBadgesVisible(): [boolean, (v: boolean) => void] {
  const visible = useSyncExternalStore(subscribeNavBadge, getNavBadgeSnapshot, () => true);
  return [visible, setNavBadgesVisible];
}

interface NavTab {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  /** 'red' | 'amber' badge pulled from live counts */
  badgeColor?: 'red' | 'amber';
  badgeKey?: 'triage' | 'sort';
  elevated?: boolean;
}

const tabs: NavTab[] = [
  { href: '/today', label: 'Today', icon: Sun },
  { href: '/triage', label: 'Triage', icon: Layers, badgeColor: 'red', badgeKey: 'triage' },
  { href: '/capture', label: 'Capture', icon: PlusCircle, elevated: true },
  { href: '/quick-sort', label: 'Sort', icon: Zap, badgeColor: 'amber', badgeKey: 'sort' },
  { href: '/ai', label: 'Houston', icon: HoustonIcon },
];

/** Lightweight hook that polls badge counts for Triage (pending) and Sort (queue).
 *  Only activates on mobile viewports and pauses when the tab is hidden. */
function useBadgeCounts() {
  const [counts, setCounts] = useState<{ triage: number; sort: number }>({ triage: 0, sort: 0 });

  useEffect(() => {
    // Only poll on mobile-width screens where the nav is visible
    const mql = window.matchMedia('(max-width: 639px)');
    if (!mql.matches) return;

    let abortController: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function fetchCounts() {
      abortController = new AbortController();
      const signal = abortController.signal;

      const results = await Promise.allSettled([
        fetch('/api/triage?status=pending&limit=0', { signal }),
        fetch('/api/tasks/quick-sort?counts=true', { signal }),
      ]);

      if (signal.aborted) return;

      // Update each badge independently so one failure doesn't reset the other
      const triageResult = results[0];
      if (triageResult.status === 'fulfilled' && triageResult.value.ok) {
        try {
          const data = await triageResult.value.json();
          const triageCount = data?.stats?.pending ?? data?.totalFiltered ?? 0;
          setCounts(prev => ({ ...prev, triage: triageCount }));
        } catch { /* ignore parse error */ }
      }

      const sortResult = results[1];
      if (sortResult.status === 'fulfilled' && sortResult.value.ok) {
        try {
          const data = await sortResult.value.json();
          // Use no_priority as the primary queue metric to avoid double-counting
          // tasks that are missing multiple fields
          const sortCount = data?.counts?.no_priority ?? 0;
          setCounts(prev => ({ ...prev, sort: sortCount }));
        } catch { /* ignore parse error */ }
      }

      // Schedule next poll after completion (prevents overlapping requests)
      timer = setTimeout(fetchCounts, 60_000);
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        // Pause polling and abort in-flight request
        if (timer) { clearTimeout(timer); timer = null; }
        abortController?.abort();
      } else {
        // Resume with a fresh fetch
        void fetchCounts();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void fetchCounts();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      abortController?.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return counts;
}

function Badge({ count, color }: { count: number; color: 'red' | 'amber' }) {
  if (count <= 0) return null;
  const display = count > 99 ? '99+' : String(count);
  return (
    <span
      className={cn(
        'absolute -top-2.5 -right-5 min-w-[16px] h-4 px-1 rounded-full text-[11px] font-bold leading-4 text-center pointer-events-none',
        color === 'red' ? 'bg-red-500 text-white' : 'bg-amber-400 text-amber-950'
      )}
      aria-label={`${count} items`}
    >
      {display}
    </span>
  );
}

/** Elevated Capture FAB with long-press-to-dictate support. */
function CaptureFab({ href, isActive }: { href: string; isActive: boolean }) {
  const router = useRouter();
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const finalTranscriptRef = useRef('');
  const [showVoiceSheet, setShowVoiceSheet] = useState(false);
  const [finalTranscript, setFinalTranscript] = useState('');
  const [isStopping, setIsStopping] = useState(false);

  const handleVoiceTranscript = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const nextTranscript = finalTranscriptRef.current
      ? `${finalTranscriptRef.current} ${trimmed}`
      : trimmed;
    finalTranscriptRef.current = nextTranscript;
    setFinalTranscript(nextTranscript);
  }, []);

  const handleVoiceEnd = useCallback(() => {
    setIsStopping(false);
    setShowVoiceSheet(false);
    if (finalTranscriptRef.current) {
      router.push(`/capture?shared_title=${encodeURIComponent(finalTranscriptRef.current)}`);
    }
  }, [router]);

  const {
    state: voiceState,
    isSupported: voiceSupported,
    interimTranscript,
    startListening,
    stopListening,
  } = useVoiceCapture({
    onTranscript: handleVoiceTranscript,
    onError: (msg) => toast.error(msg),
    onEnd: handleVoiceEnd,
  });

  const isListening = voiceState === 'listening';

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  const handleTouchStart = useCallback(() => {
    didLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      if (voiceSupported) {
        finalTranscriptRef.current = '';
        setFinalTranscript('');
        setIsStopping(false);
        setShowVoiceSheet(true);
        startListening();
      }
    }, 500);
  }, [voiceSupported, startListening]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (didLongPress.current) {
      e.preventDefault();
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleStopVoice = useCallback(() => {
    setIsStopping(true);
    stopListening();
  }, [stopListening]);

  const displayedTranscript = [finalTranscript, interimTranscript.trim()]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <Link
        href={href}
        aria-current={isActive ? 'page' : undefined}
        aria-label="Capture — hold to dictate"
        className="flex flex-col items-center justify-center gap-0.5 min-w-[56px] min-h-[44px] -mt-4"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onClick={(e) => {
          if (didLongPress.current) {
            e.preventDefault();
          }
        }}
      >
        <span
          className={cn(
            'flex items-center justify-center w-12 h-12 rounded-full shadow-lg transition-colors',
            isListening
              ? 'bg-red-500 text-white animate-pulse'
              : isActive
                ? 'bg-[var(--accent-600)] text-white'
                : 'bg-[var(--accent-600)] text-white opacity-90'
          )}
        >
          {isListening ? <Mic size={24} /> : <PlusCircle size={24} />}
        </span>
        <span
          className={cn(
            'text-[11px] font-medium leading-tight',
            isListening
              ? 'text-red-400'
              : isActive ? 'text-[var(--accent-400)]' : 'text-[var(--text-tertiary)]'
          )}
        >
          {isListening ? 'Listening…' : 'Capture'}
        </span>
      </Link>

      {/* Voice dictation sheet */}
      {showVoiceSheet && (
        <div className="fixed inset-x-0 bottom-16 z-50 flex justify-center px-4 pb-2 safe-area-pb">
          <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[var(--text-secondary)]">
                {isStopping ? 'Stopping…' : isListening ? 'Listening — speak your task' : 'Processing…'}
              </span>
              <button
                type="button"
                onClick={handleStopVoice}
                aria-label={isStopping ? 'Stopping voice capture' : 'Stop voice capture'}
                disabled={isStopping}
                className="flex min-h-[44px] items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 text-xs font-medium text-red-400"
              >
                <Square size={10} className="fill-current" />
                Stop
              </button>
            </div>
            {displayedTranscript && (
              <p className="text-sm text-[var(--text-primary)] italic">
                {displayedTranscript}
              </p>
            )}
            {!displayedTranscript && isListening && (
              <p className="text-xs text-[var(--text-tertiary)]">
                Say something to create a task…
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function MobileBottomNav() {
  const pathname = usePathname();
  const badgeCounts = useBadgeCounts();
  const [navBadgesVisible] = useNavBadgesVisible();

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 sm:hidden bg-[var(--surface-1)] border-t border-[var(--border)] safe-area-pb"
      aria-label="Mobile navigation"
    >
      <div className="flex items-center justify-around h-14">
        {tabs.map((tab) => {
          const isActive = pathname.startsWith(tab.href);
          const Icon = tab.icon;
          const badgeCount = tab.badgeKey ? badgeCounts[tab.badgeKey] : 0;

          if (tab.elevated) {
            return <CaptureFab key={tab.href} href={tab.href} isActive={isActive} />;
          }

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative flex flex-col items-center justify-center gap-0.5 min-w-[56px] min-h-[44px] px-2 py-1 rounded-lg transition-colors',
                isActive
                  ? 'text-[var(--accent-400)]'
                  : 'text-[var(--text-tertiary)]'
              )}
            >
              <span className="relative">
                <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
                {navBadgesVisible && tab.badgeColor && <Badge count={badgeCount} color={tab.badgeColor} />}
              </span>
              <span className="text-[11px] font-medium leading-tight">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
