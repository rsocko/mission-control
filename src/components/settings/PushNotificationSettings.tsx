'use client';

/**
 * Push Notification Settings — iOS-style settings panel for configuring
 * push notification triggers (morning, triage nudge, carry-forward),
 * quiet hours, and do-not-disturb mode.
 *
 * Used by both the mobile Notifications settings screen and the desktop
 * settings page.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BellOff,
  Moon,
  Sun,
  Inbox,
  Sunset,
  RefreshCw,
  Power,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SectionCard, SectionLabel, Toggle } from '@/components/settings/SettingsPrimitives';
import {
  addMCNativeBridgeEventListener,
  getMCNativeBridge,
  requestMCNativeBridge,
  type NativeBridgeWindow,
} from '@/lib/native/bridge';

/* ─────── Types ─────── */

interface PushPreferences {
  morningEnabled: boolean;
  morningHour: number;
  triageNudgeEnabled: boolean;
  triageNudgeThreshold: number;
  carryForwardEnabled: boolean;
  carryForwardHour: number;
  quietStart: number | null;
  quietEnd: number | null;
  doNotDisturb: boolean;
}

interface SchedulerJob {
  name: string;
  schedule: string;
  lastRun?: string;
  lastResult?: string;
  lastError?: string;
}

interface SchedulerStatus {
  running: boolean;
  jobs: SchedulerJob[];
}

const DEFAULT_PREFS: PushPreferences = {
  morningEnabled: true,
  morningHour: 8,
  triageNudgeEnabled: true,
  triageNudgeThreshold: 5,
  carryForwardEnabled: true,
  carryForwardHour: 18,
  quietStart: null,
  quietEnd: null,
  doNotDisturb: false,
};

/* ─────── Sub-components ─────── */

function HourPicker({ value, onChange, label }: { value: number; onChange: (h: number) => void; label: string }) {
  const formatHour = (h: number) => {
    if (h === 0) return '12 AM';
    if (h === 12) return '12 PM';
    return h < 12 ? `${h} AM` : `${h - 12} PM`;
  };

  return (
    <Select value={String(value)} onValueChange={(nextValue) => onChange(Number(nextValue))}>
      <SelectTrigger variant="inline" aria-label={label} className="w-20">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 24 }, (_, i) => (
          <SelectItem key={i} value={String(i)}>{formatHour(i)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SettingRow({
  icon,
  label,
  description,
  trailing,
  isLast = false,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  trailing: React.ReactNode;
  isLast?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-3.5',
        !isLast && 'border-b border-[var(--border-subtle)]'
      )}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0 mr-3">
        <span className="text-[var(--text-muted)] flex-shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm text-[var(--text-primary)]">{label}</p>
          {description && (
            <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{description}</p>
          )}
        </div>
      </div>
      <div className="flex-shrink-0">{trailing}</div>
    </div>
  );
}

/* ─────── Main Component ─────── */

export function PushNotificationSettings() {
  const [prefs, setPrefs] = useState<PushPreferences>(DEFAULT_PREFS);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nativePushState, setNativePushState] = useState<
    | 'unavailable'
    | 'prompt'
    | 'requesting'
    | 'unregistered'
    | 'registering'
    | 'registered'
    | 'denied'
    | 'failed'
  >('unavailable');
  const [showNativeSoftPrompt, setShowNativeSoftPrompt] = useState(false);

  // Fetch preferences and scheduler status
  useEffect(() => {
    async function load() {
      try {
        const [prefsRes, schedulerRes] = await Promise.all([
          fetch('/api/push/preferences'),
          fetch('/api/push/scheduler'),
        ]);
        if (prefsRes.ok) setPrefs(await prefsRes.json());
        if (schedulerRes.ok) setScheduler(await schedulerRes.json());
      } catch {
        // Silent fail
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  useEffect(() => {
    const windowObject = window as unknown as NativeBridgeWindow;
    const configuredOrigin = window.location.origin;
    if (!getMCNativeBridge(windowObject, configuredOrigin)) return;
    let active = true;
    queueMicrotask(() => {
      if (active) setNativePushState('prompt');
    });
    const removeListener = addMCNativeBridgeEventListener({
      action: 'pushRegistrationChanged',
      configuredOrigin,
      windowObject,
      listener: event => {
        if (event.payload.authorization === 'denied') {
          setNativePushState('denied');
          return;
        }
        setNativePushState(event.payload.state);
      },
    });
    return () => {
      active = false;
      removeListener();
    };
  }, []);

  const requestNativePush = useCallback(async () => {
    setShowNativeSoftPrompt(false);
    setNativePushState('requesting');
    try {
      const response = await requestMCNativeBridge({
        action: 'requestPushPermission',
        configuredOrigin: window.location.origin,
        payload: { context: 'settings' },
        windowObject: window as unknown as NativeBridgeWindow,
      });
      if (!response.ok) {
        setNativePushState(response.error.code === 'PERMISSION_DENIED' ? 'denied' : 'failed');
      } else if (response.result.authorization === 'denied') {
        setNativePushState('denied');
      } else if (response.result.authorization === 'notDetermined') {
        setNativePushState('prompt');
      } else {
        setNativePushState('registering');
      }
    } catch {
      setNativePushState('failed');
    }
  }, []);

  // Save preferences — debounced to serialize rapid toggles
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPrefsRef = useRef<PushPreferences>(prefs);

  const savePrefs = useCallback((updated: PushPreferences) => {
    setPrefs(updated);
    latestPrefsRef.current = updated;

    // Debounce: wait 400ms so rapid changes batch into one PUT
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        const res = await fetch('/api/push/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(latestPrefsRef.current),
        });
        if (res.ok) {
          // Refresh scheduler status (preferences save restarts it)
          const sRes = await fetch('/api/push/scheduler');
          if (sRes.ok) setScheduler(await sRes.json());
        } else {
          // Refetch server state on failure so UI stays consistent
          const fallback = await fetch('/api/push/preferences');
          if (fallback.ok) {
            const serverPrefs = await fallback.json();
            setPrefs(serverPrefs);
            latestPrefsRef.current = serverPrefs;
          }
        }
      } catch {
        // Silent fail — next interaction will retry
      } finally {
        setSaving(false);
      }
    }, 400);
  }, []);

  // Scheduler control
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const toggleScheduler = useCallback(async () => {
    if (!scheduler || schedulerBusy) return;
    setSchedulerBusy(true);
    const action = scheduler.running ? 'stop' : 'start';
    try {
      const res = await fetch('/api/push/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) setScheduler(await res.json());
    } catch {
      // Silent fail
    } finally {
      setSchedulerBusy(false);
    }
  }, [scheduler, schedulerBusy]);

  const update = (partial: Partial<PushPreferences>) => {
    savePrefs({ ...prefs, ...partial });
  };

  const nativePushDescription = {
    denied: 'Notifications are disabled. Tap below for iOS Settings guidance.',
    failed: 'This iPhone could not be registered. Check your connection and try again.',
    registered: 'This iPhone is registered for Mission Control notifications.',
    registering: 'Registering this iPhone for native notifications...',
    requesting: 'Waiting for iOS notification permission...',
    unregistered: 'This iPhone is not registered for native notifications.',
    prompt: 'Get your morning plan, triage nudges, and carry-forward reminders.',
    unavailable: '',
  }[nativePushState];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={18} className="animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {nativePushState !== 'unavailable' && (
        <>
          <SectionLabel>iPhone Notifications</SectionLabel>
          <SectionCard>
            <div className="px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-[var(--text-primary)]">Native push delivery</p>
                  <p
                    role="status"
                    aria-live="polite"
                    className="text-[11px] text-[var(--text-tertiary)] mt-1"
                  >
                    {nativePushDescription}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNativeSoftPrompt(true)}
                  disabled={nativePushState === 'requesting' || nativePushState === 'registering'}
                  className="rounded-lg bg-[var(--accent-500)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {nativePushState === 'registered' || nativePushState === 'denied'
                    ? 'Manage'
                    : 'Enable'}
                </button>
              </div>
              {showNativeSoftPrompt && (
                <div
                  role="group"
                  aria-label="Enable iPhone notifications"
                  className="mt-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3"
                >
                  <p className="text-xs text-[var(--text-secondary)]">
                    Mission Control sends only the reminders you configure. You can change this
                    later in iOS Settings.
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowNativeSoftPrompt(false)}
                      className="rounded-lg px-3 py-1.5 text-xs text-[var(--text-secondary)]"
                    >
                      Not now
                    </button>
                    <button
                      type="button"
                      onClick={requestNativePush}
                      className="rounded-lg bg-[var(--accent-500)] px-3 py-1.5 text-xs font-medium text-white"
                    >
                      Continue
                    </button>
                  </div>
                </div>
              )}
            </div>
          </SectionCard>
        </>
      )}

      {/* ─── Global Controls ─── */}
      <SectionLabel>Global</SectionLabel>
      <SectionCard>
        <SettingRow
          icon={<BellOff size={14} />}
          label="Do Not Disturb"
          description="Suppress all push notifications"
          trailing={
            <Toggle
              enabled={prefs.doNotDisturb}
              onChange={(v) => update({ doNotDisturb: v })}
              label="Do Not Disturb"
            />
          }
        />
        <SettingRow
          icon={<Power size={14} />}
          label="Notification Scheduler"
          description={scheduler?.running ? 'Running — triggers fire on schedule' : 'Stopped — no automatic triggers'}
          trailing={
            <Toggle
              enabled={scheduler?.running ?? false}
              onChange={schedulerBusy ? () => {} : toggleScheduler}
              label="Notification Scheduler"
            />
          }
          isLast
        />
      </SectionCard>

      {/* ─── Triggers ─── */}
      <SectionLabel>Triggers</SectionLabel>
      <SectionCard>
        <SettingRow
          icon={<Sun size={14} />}
          label="Morning Summary"
          description="Daily 'Start My Day' briefing"
          trailing={
            <div className="flex items-center gap-2">
              <HourPicker
                value={prefs.morningHour}
                onChange={(h) => update({ morningHour: h })}
                label="Morning hour"
              />
              <Toggle
                enabled={prefs.morningEnabled}
                onChange={(v) => update({ morningEnabled: v })}
                label="Morning Summary"
              />
            </div>
          }
        />
        <SettingRow
          icon={<Inbox size={14} />}
          label="Triage Nudge"
          description={`Notify when queue exceeds ${prefs.triageNudgeThreshold} items`}
          trailing={
            <div className="flex items-center gap-2">
              <Select
                value={String(prefs.triageNudgeThreshold)}
                onValueChange={(value) => update({ triageNudgeThreshold: Number(value) })}
              >
                <SelectTrigger variant="inline" aria-label="Triage threshold" className="w-16">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[3, 5, 10, 15, 20, 25, 50].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Toggle
                enabled={prefs.triageNudgeEnabled}
                onChange={(v) => update({ triageNudgeEnabled: v })}
                label="Triage Nudge"
              />
            </div>
          }
        />
        <SettingRow
          icon={<Sunset size={14} />}
          label="Carry-Forward Reminder"
          description="Evening reminder for incomplete tasks"
          trailing={
            <div className="flex items-center gap-2">
              <HourPicker
                value={prefs.carryForwardHour}
                onChange={(h) => update({ carryForwardHour: h })}
                label="Carry-forward hour"
              />
              <Toggle
                enabled={prefs.carryForwardEnabled}
                onChange={(v) => update({ carryForwardEnabled: v })}
                label="Carry-Forward Reminder"
              />
            </div>
          }
          isLast
        />
      </SectionCard>

      {/* ─── Quiet Hours ─── */}
      <SectionLabel>Quiet Hours</SectionLabel>
      <SectionCard>
        <SettingRow
          icon={<Moon size={14} />}
          label="Quiet Hours"
          description={
            prefs.quietStart !== null && prefs.quietEnd !== null
              ? `Notifications suppressed ${formatHourLabel(prefs.quietStart)} – ${formatHourLabel(prefs.quietEnd)}`
              : 'No quiet hours set'
          }
          trailing={
            <Toggle
              enabled={prefs.quietStart !== null}
              onChange={(v) => {
                if (v) {
                  update({ quietStart: 22, quietEnd: 7 });
                } else {
                  update({ quietStart: null, quietEnd: null });
                }
              }}
              label="Quiet Hours"
            />
          }
        />
        {prefs.quietStart !== null && prefs.quietEnd !== null && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border-subtle)]">
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--text-tertiary)]">From</span>
              <HourPicker
                value={prefs.quietStart}
                onChange={(h) => update({ quietStart: h })}
                label="Quiet start"
              />
              <span className="text-xs text-[var(--text-tertiary)]">to</span>
              <HourPicker
                value={prefs.quietEnd!}
                onChange={(h) => update({ quietEnd: h })}
                label="Quiet end"
              />
            </div>
          </div>
        )}
      </SectionCard>

      {/* ─── Scheduler Status ─── */}
      {scheduler && scheduler.jobs.length > 0 && (
        <>
          <SectionLabel>Schedule Status</SectionLabel>
          <SectionCard>
            {scheduler.jobs.map((job, i) => (
              <div
                key={job.name}
                className={cn(
                  'flex items-center justify-between px-4 py-3',
                  i < scheduler.jobs.length - 1 && 'border-b border-[var(--border-subtle)]'
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm text-[var(--text-primary)] capitalize">{job.name.replace(/-/g, ' ')}</p>
                  <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 font-mono">{job.schedule}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  {job.lastRun ? (
                    <>
                      <p className={cn(
                        'text-[11px]',
                        job.lastResult === 'sent' ? 'text-emerald-400' :
                        job.lastResult === 'error' ? 'text-red-400' :
                        'text-[var(--text-tertiary)]'
                      )}>
                        {job.lastResult === 'sent' ? '✓ Sent' :
                         job.lastResult === 'error' ? '✗ Error' :
                         '— Skipped'}
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)]">
                        {formatRelativeTime(job.lastRun)}
                      </p>
                    </>
                  ) : (
                    <p className="text-[11px] text-[var(--text-muted)]">Not run yet</p>
                  )}
                </div>
              </div>
            ))}
          </SectionCard>
        </>
      )}

      {saving && (
        <p className="text-center text-[11px] text-[var(--text-muted)] mt-2">
          Saving...
        </p>
      )}
    </div>
  );
}

/* ─────── Helpers ─────── */

function formatHourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
