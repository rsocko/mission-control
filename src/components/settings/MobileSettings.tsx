'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Palette,
  Bell,
  Hand,
  Languages,
  ChevronRight,
  RefreshCw,
  Download,
  CirclePlus,
  GitBranch,
  Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import { useNavigationBadgePreferences } from '@/lib/hooks/useNavigationBadges';
import { NAV_BADGE_OPTIONS } from '@/lib/navigation/badges';
import { COMPLETION_ANIMATION_KEY, setCompletionAnimationEnabled } from '@/components/ui/CompletionBurst';
import { LocalSourceIcon } from '@/components/ui/LocalSourceIcon';
import { CaptureDestinationSection } from '@/app/settings/components/CaptureSettingsSection';
import { SectionCard, SectionLabel, Toggle } from '@/components/settings/SettingsPrimitives';
import {
  DEFAULT_QUICK_ADD_PREFERENCES,
  getQuickAddPreferences,
  setQuickAddPreferences,
  type QuickAddPreferences,
} from '@/lib/quick-add-preferences';
import { toast } from 'sonner';
import {
  getLatestConnectorSync,
  loadConnectorData,
  requestConnectorSync,
} from '@/lib/connectors/client';
import { APP_NAME, APP_VERSION } from '@/lib/app-metadata';

function SettingsRow({
  icon,
  label,
  value,
  trailing,
  onClick,
  isLast = false,
}: {
  icon?: React.ReactNode;
  label: string;
  value?: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  isLast?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-between w-full px-4 py-3.5 text-left transition-colors active:bg-[var(--surface-2)]',
        !isLast && 'border-b border-[var(--border-subtle)]'
      )}
      aria-label={label}
    >
      <div className="flex items-center gap-3 min-w-0">
        {icon && <span className="text-[var(--text-muted)]">{icon}</span>}
        <span className="text-sm text-[var(--text-primary)] truncate">{label}</span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {value && <span className="text-xs text-[var(--text-tertiary)]">{value}</span>}
        {trailing || <ChevronRight size={12} className="text-[var(--text-muted)]" />}
      </div>
    </button>
  );
}

/* ─────── Types ─────── */

interface ConnectedService {
  id: string;
  name: string;
  type: string;
  connected: boolean;
}

/* ─────── Main Component ─────── */

/**
 * Mobile-optimized Settings screen matching the iOS mockup (Screen 20).
 *
 * Sections: Account, Preferences, Notifications, Connected Services, Sync, About
 * Covers:
 * - F-99: Sections layout
 * - F-100: Toggle-based preferences
 * - F-101: Sync status and manual trigger
 */
export function MobileSettings() {
  const router = useRouter();
  const { progress } = useSyncStream();

  const { preferences: navBadgePreferences, setEnabled: setNavBadgesEnabled, setItemEnabled } =
    useNavigationBadgePreferences();

  // Completion animation setting (persisted in localStorage)
  const [animationEnabled, setAnimationEnabled] = useState(true);
  const [quickAddPreferences, setQuickAddPreferencesState] = useState<QuickAddPreferences>(DEFAULT_QUICK_ADD_PREFERENCES);
  useEffect(() => {
    setAnimationEnabled(localStorage.getItem(COMPLETION_ANIMATION_KEY) !== 'false');
    setQuickAddPreferencesState(getQuickAddPreferences());
  }, []);
  const handleAnimationToggle = useCallback((enabled: boolean) => {
    setAnimationEnabled(enabled);
    setCompletionAnimationEnabled(enabled);
  }, []);
  const updateQuickAddPreferences = useCallback((updates: Partial<QuickAddPreferences>) => {
    setQuickAddPreferencesState((current) => {
      const next = { ...current, ...updates };
      try {
        setQuickAddPreferences(next);
        return next;
      } catch {
        toast.error('Failed to save Quick Add preferences');
        return current;
      }
    });
  }, []);

  // Connected services
  const [services, setServices] = useState<ConnectedService[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);

  // Sync state (F-101)
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Fetch connected services
  useEffect(() => {
    async function fetchServices() {
      try {
        const { connectors } = await loadConnectorData();
        setServices(connectors.map(connector => ({
          id: connector.id,
          name: connector.name,
          type: connector.type,
          connected: connector.enabled,
        })));
        setLastSyncTime(getLatestConnectorSync(connectors));
      } catch {
        // Silent fail on mobile
      } finally {
        setServicesLoading(false);
      }
    }
    fetchServices();
  }, []);

  // Manual sync trigger (F-101)
  const triggerSync = useCallback(async () => {
    setSyncing(true);
    try {
      await requestConnectorSync();
      setLastSyncTime(new Date().toISOString());
    } catch {
      // Silent fail
    } finally {
      setSyncing(false);
    }
  }, []);

  const isSyncing = progress.isSyncing || syncing;
  const syncStatusText = isSyncing
    ? 'Syncing...'
    : lastSyncTime
      ? `Last synced ${formatRelativeTime(lastSyncTime)}`
      : 'All synced';

  return (
    <div className="flex-1 overflow-y-auto overscroll-y-contain px-4 pb-28 pt-4 sm:hidden">
      {/* ─── Account ─── */}
      <SectionCard>
        <button
          type="button"
          className="flex items-center gap-3 w-full px-4 py-4 text-left active:bg-[var(--surface-2)] transition-colors"
          aria-label="Account settings"
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-violet-500 flex-shrink-0">
            <span className="text-sm font-bold text-white">MC</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-[var(--text-primary)]">Mission Control</p>
            <p className="text-xs text-[var(--text-tertiary)]">Local instance</p>
          </div>
          <ChevronRight size={14} className="text-[var(--text-muted)] flex-shrink-0" />
        </button>
      </SectionCard>

      {/* ─── General ─── */}
      <SectionLabel>General</SectionLabel>
      <SectionCard>
        <SettingsRow
          icon={<Palette size={14} />}
          label="Appearance"
          value="Dark"
          onClick={() => router.push('/settings/general')}
        />
        <SettingsRow
          icon={<Bell size={14} />}
          label="Notifications"
          onClick={() => router.push('/settings/notifications')}
        />
        <SettingsRow
          icon={<Hand size={14} />}
          label="Swipe Gestures"
          onClick={() => router.push('/settings/shortcuts')}
        />
        <SettingsRow
          icon={<Languages size={14} />}
          label="Language"
          value="English"
          onClick={() => router.push('/settings/general')}
          isLast
        />
      </SectionCard>

      {/* ─── Preferences (F-100: toggle-based) ─── */}
      <SectionLabel>Preferences</SectionLabel>
      <SectionCard>
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border-subtle)]">
          <div className="flex-1 min-w-0 mr-3">
            <p className="text-sm text-[var(--text-primary)]">Navigation Badges</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">Master control for navigation counts</p>
          </div>
          <Toggle
            enabled={navBadgePreferences.enabled}
            onChange={setNavBadgesEnabled}
            label="Navigation Badges"
          />
        </div>
        {NAV_BADGE_OPTIONS.map((option) => (
          <div
            key={option.key}
            className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border-subtle)]"
          >
            <div className="flex-1 min-w-0 mr-3">
              <p className="text-sm text-[var(--text-primary)]">{option.label}</p>
              <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{option.description}</p>
            </div>
            <Toggle
              enabled={navBadgePreferences.items[option.key]}
              onChange={(enabled) => setItemEnabled(option.key, enabled)}
              label={`Show ${option.label} badge`}
            />
          </div>
        ))}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border-subtle)]">
          <div className="flex-1 min-w-0 mr-3">
            <p className="text-sm text-[var(--text-primary)]">Completion Animations</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">Celebrate when tasks are completed</p>
          </div>
          <Toggle
            enabled={animationEnabled}
            onChange={handleAnimationToggle}
            label="Completion Animations"
          />
        </div>
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border-subtle)]">
          <div className="flex-1 min-w-0 mr-3">
            <p className="text-sm text-[var(--text-primary)]">Date Suggestions</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">Recognize trailing natural-language dates</p>
          </div>
          <Toggle
            enabled={quickAddPreferences.naturalLanguageDates}
            onChange={(enabled) => updateQuickAddPreferences({ naturalLanguageDates: enabled })}
            label="Natural-language date suggestions"
          />
        </div>
        <div className="flex items-center justify-between px-4 py-3.5">
          <div className="flex-1 min-w-0 mr-3">
            <p className="text-sm text-[var(--text-primary)]">Preserve Quick Add Tokens</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">Keep metadata tokens in saved titles</p>
          </div>
          <Toggle
            enabled={quickAddPreferences.preserveText}
            onChange={(enabled) => updateQuickAddPreferences({ preserveText: enabled })}
            label="Preserve metadata tokens"
          />
        </div>
      </SectionCard>

      <SectionLabel>Capture</SectionLabel>
      <CaptureDestinationSection mobile />

      {/* ─── Connected Services (F-99) ─── */}
      <SectionLabel>Connected Services</SectionLabel>
      <SectionCard>
        {servicesLoading ? (
          <div className="flex items-center justify-center py-6">
            <RefreshCw size={16} className="animate-spin text-[var(--text-muted)]" />
          </div>
        ) : services.length === 0 ? (
          <div className="px-4 py-4">
            <p className="text-sm text-[var(--text-tertiary)]">No services connected yet.</p>
          </div>
        ) : (
          services.map((service, i) => (
            <div
              key={service.id}
              className={cn(
                'flex items-center justify-between px-4 py-3.5',
                i < services.length - 1 && 'border-b border-[var(--border-subtle)]'
              )}
            >
              <div className="flex items-center gap-3">
                {getConnectorIcon(service.type)}
                <span className="text-sm text-[var(--text-primary)]">{service.name}</span>
              </div>
              {service.connected && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <Check size={10} />
                  Connected
                </span>
              )}
            </div>
          ))
        )}
        <button
          type="button"
          className={cn(
            'flex items-center gap-3 w-full px-4 py-3.5 text-left active:bg-[var(--surface-2)] transition-colors',
            services.length > 0 && 'border-t border-[var(--border-subtle)]'
          )}
          onClick={() => router.push('/settings/connectors')}
          aria-label="Add integration"
        >
          <CirclePlus size={14} className="text-[var(--accent-400)]" />
          <span className="text-sm text-[var(--accent-400)]">Add integration...</span>
        </button>
      </SectionCard>

      {/* ─── Sync / Data (F-101) ─── */}
      <SectionLabel>Data</SectionLabel>
      <SectionCard>
        {/* Sync status indicator */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-3">
            <RefreshCw
              size={14}
              className={cn('text-[var(--text-muted)]', isSyncing && 'animate-spin text-blue-400')}
            />
            <span className="text-sm text-[var(--text-primary)]">Sync Status</span>
          </div>
          <span className={cn('text-xs flex items-center gap-1', isSyncing ? 'text-blue-400' : 'text-emerald-400')}>
            {!isSyncing && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
            {syncStatusText}
          </span>
        </div>
        {/* Manual sync trigger */}
        <button
          type="button"
          onClick={triggerSync}
          disabled={isSyncing}
          className="flex items-center justify-between w-full px-4 py-3.5 border-b border-[var(--border-subtle)] text-left active:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
          aria-label="Sync now"
        >
          <div className="flex items-center gap-3">
            <RefreshCw size={14} className="text-[var(--accent-400)]" />
            <span className="text-sm text-[var(--accent-400)] font-medium">Sync Now</span>
          </div>
        </button>
        {/* Export */}
        <SettingsRow
          icon={<Download size={14} />}
          label="Export Data"
          isLast
        />
      </SectionCard>

      {/* ─── About ─── */}
      <SectionLabel>About</SectionLabel>
      <SectionCard>
        <SettingsRow
          label={`About ${APP_NAME}`}
          value={`v${APP_VERSION}`}
          onClick={() => router.push('/settings/about')}
        />
        <SettingsRow
          label="Storage & Cache"
          onClick={() => router.push('/settings/storage')}
        />
        <SettingsRow
          label="AI Provider"
          onClick={() => router.push('/settings/ai-provider')}
          isLast
        />
      </SectionCard>

      {/* Footer */}
      <p className="mt-5 mb-4 text-center text-xs text-[var(--text-muted)]">
        {APP_NAME} v{APP_VERSION}
      </p>
    </div>
  );
}

/* ─────── Helpers ─────── */

function getConnectorIcon(type: string): React.ReactNode {
  switch (type) {
    case 'local':
      return <LocalSourceIcon size={14} />;
    case 'github':
    case 'github-issues':
      return <GitBranch size={14} className="text-violet-300" />;
    case 'microsoft-todo':
      return <Check size={14} className="text-blue-400" />;
    default:
      return <CirclePlus size={14} className="text-slate-400" />;
  }
}

function formatRelativeTime(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}
