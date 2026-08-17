'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useRef, useCallback } from 'react';
import { Sun, Layers, PlusCircle, Zap, Mic, Square } from 'lucide-react';
import { toast } from 'sonner';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import { useVoiceCapture } from '@/lib/hooks/useVoiceCapture';
import { cn } from '@/lib/utils';
import { NavigationBadge } from '@/components/layout/NavigationBadge';
import {
  useNavigationBadgePreferences,
} from '@/lib/hooks/useNavigationBadges';
import {
  EMPTY_NAVIGATION_COUNTS,
  type NavBadgeKey,
  type NavBadgeTone,
  type NavigationCounts,
} from '@/lib/navigation/badges';

interface NavTab {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  badgeTone?: NavBadgeTone;
  badgeKey?: NavBadgeKey;
  elevated?: boolean;
}

const tabs: NavTab[] = [
  { href: '/today', label: 'Today', icon: Sun, badgeTone: 'amber', badgeKey: 'myDay' },
  { href: '/triage', label: 'Triage', icon: Layers, badgeTone: 'red', badgeKey: 'triage' },
  { href: '/capture', label: 'Capture', icon: PlusCircle, elevated: true },
  { href: '/quick-sort', label: 'Sort', icon: Zap, badgeTone: 'amber', badgeKey: 'quickSort' },
  { href: '/ai', label: 'Houston', icon: HoustonIcon },
];

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

export function MobileBottomNav({
  counts = EMPTY_NAVIGATION_COUNTS,
}: {
  counts?: NavigationCounts;
}) {
  const pathname = usePathname();
  const { preferences } = useNavigationBadgePreferences();

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 sm:hidden bg-[var(--surface-1)] border-t border-[var(--border)] safe-area-pb"
      aria-label="Mobile navigation"
    >
      <div className="flex items-center justify-around h-14">
        {tabs.map((tab) => {
          const isActive = pathname.startsWith(tab.href);
          const Icon = tab.icon;
          const badgeCount = tab.badgeKey ? counts[tab.badgeKey] : 0;

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
                {preferences.enabled && tab.badgeKey && preferences.items[tab.badgeKey] && tab.badgeTone && (
                  <NavigationBadge count={badgeCount} tone={tab.badgeTone} overlay />
                )}
              </span>
              <span className="text-[11px] font-medium leading-tight">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
