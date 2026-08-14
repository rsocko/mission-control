'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Loader2, Clock, CheckCircle2, Sparkles, GripVertical, Trash2, Plus, Zap, Check, PenLine, X, CalendarDays,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { COMPLETION_ANIMATION_KEY, setCompletionAnimationEnabled } from '@/components/ui/CompletionBurst';
import { BadgeSettingsCard } from './BadgeSettingsCard';
import { NavBadgeSettingsCard } from './NavBadgeSettingsCard';
import { SyncIconSettingsCard } from './SyncIconSettingsCard';
import { CaptureDestinationSection, InboxListsSection } from './CaptureSettingsSection';
import { settingsLogger } from '@/lib/client-logger';
import { toast } from 'sonner';
import {
  DEFAULT_QUICK_ADD_PREFERENCES,
  getQuickAddPreferences,
  setQuickAddPreferences,
  type QuickAddPreferences,
} from '@/lib/quick-add-preferences';

// --- General Settings Section ------------------------------------------------

const COMMON_TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (US)' },
  { value: 'America/Chicago', label: 'Central Time (US)' },
  { value: 'America/Denver', label: 'Mountain Time (US)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
  { value: 'America/Anchorage', label: 'Alaska Time' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time' },
  { value: 'America/Phoenix', label: 'Arizona (no DST)' },
  { value: 'America/Toronto', label: 'Eastern Time (Canada)' },
  { value: 'America/Vancouver', label: 'Pacific Time (Canada)' },
  { value: 'America/Halifax', label: 'Atlantic Time (Canada)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
  { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
  { value: 'Pacific/Auckland', label: 'Auckland (NZST)' },
  { value: 'UTC', label: 'UTC' },
];

function GeneralSettingsSection() {
  const [timezone, setTimezone] = useState<string>('');
  const [detectedTz, setDetectedTz] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [animationEnabled, setAnimationEnabled] = useState(true);
  const [quickAddPreferences, setQuickAddPreferencesState] = useState<QuickAddPreferences>(DEFAULT_QUICK_ADD_PREFERENCES);

  useEffect(() => {
    // Detect browser timezone
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setDetectedTz(browserTz);

    // Fetch saved timezone from settings
    fetch('/api/settings/mode')
      .then(r => r.json())
      .then(d => {
        setTimezone(d.timezone || browserTz);
      })
      .catch(() => setTimezone(browserTz));

    // Load completion animation preference
    const stored = localStorage.getItem(COMPLETION_ANIMATION_KEY);
    setAnimationEnabled(stored !== 'false');
    setQuickAddPreferencesState(getQuickAddPreferences());
  }, []);

  function updateQuickAddPreferences(updates: Partial<QuickAddPreferences>) {
    const next = { ...quickAddPreferences, ...updates };
    try {
      setQuickAddPreferences(next);
      setQuickAddPreferencesState(next);
    } catch {
      toast.error('Failed to save Quick Add preferences');
    }
  }

  async function saveTimezone(tz: string) {
    setTimezone(tz);
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/settings/mode', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: tz }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Revert on error
    }
    setSaving(false);
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-1">General</h2>
      <p className="text-sm text-[var(--text-tertiary)] mb-6">App-wide preferences</p>

      <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={18} className="text-[var(--text-muted)]" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Timezone</h3>
        </div>
        <p className="text-xs text-[var(--text-tertiary)] mb-3">
          Used for calendar events, due dates, scheduling, and the daily timeline. 
          Your browser detected: <span className="font-mono text-[var(--text-secondary)]">{detectedTz}</span>
        </p>

        <div className="flex items-center gap-3">
          <Select value={timezone} onValueChange={(v) => saveTimezone(v)}>
            <SelectTrigger className="flex-1 max-w-sm px-3 py-2 text-sm bg-[var(--surface-1)] border border-[var(--border)] rounded-md text-[var(--text-primary)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMMON_TIMEZONES.map(tz => (
                <SelectItem key={tz.value} value={tz.value}>
                  {tz.label} ({tz.value})
                </SelectItem>
              ))}
              {!COMMON_TIMEZONES.some(t => t.value === timezone) && timezone && (
                <SelectItem key={timezone} value={timezone}>
                  {timezone}
                </SelectItem>
              )}
            </SelectContent>
          </Select>

          {saving && <Loader2 size={16} className="animate-spin text-blue-400" />}
          {saved && <CheckCircle2 size={16} className="text-green-400" />}
        </div>

        <button
          onClick={() => saveTimezone(detectedTz)}
          className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          Use browser timezone ({detectedTz})
        </button>
      </div>

      {/* Completion animation toggle */}
      <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles size={18} className="text-[var(--text-muted)]" />
              <h3 className="text-sm font-medium text-[var(--text-primary)]">Completion animation</h3>
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">
              Show a particle burst when completing tasks. Automatically disabled when your OS has reduced motion enabled.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={animationEnabled}
            onClick={() => {
              const next = !animationEnabled;
              setAnimationEnabled(next);
              setCompletionAnimationEnabled(next);
            }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 flex-shrink-0 ${
              animationEnabled ? 'bg-blue-500' : 'bg-[var(--surface-3)]'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200 ${
                animationEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      <SyncIconSettingsCard />

      <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-5">
        <div className="mb-4 flex items-center gap-2">
          <CalendarDays size={18} className="text-[var(--text-muted)]" />
          <div>
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Quick Add parsing</h3>
            <p className="text-xs text-[var(--text-tertiary)]">
              Control date suggestions and whether metadata tokens remain in task titles.
            </p>
          </div>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm text-[var(--text-primary)]">Natural-language date suggestions</div>
              <p className="text-xs text-[var(--text-tertiary)]">
                Suggest trailing dates such as “next Friday” without applying them automatically.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Natural-language date suggestions"
              aria-checked={quickAddPreferences.naturalLanguageDates}
              onClick={() => updateQuickAddPreferences({ naturalLanguageDates: !quickAddPreferences.naturalLanguageDates })}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                quickAddPreferences.naturalLanguageDates ? 'bg-blue-500' : 'bg-[var(--surface-3)]'
              }`}
            >
              <span className={`h-4 w-4 rounded-full bg-white transition-transform ${
                quickAddPreferences.naturalLanguageDates ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm text-[var(--text-primary)]">Preserve metadata tokens</div>
              <p className="text-xs text-[var(--text-tertiary)]">
                Keep tokens such as #tag, +Project, !high, and /due: in the saved title.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Preserve metadata tokens"
              aria-checked={quickAddPreferences.preserveText}
              onClick={() => updateQuickAddPreferences({ preserveText: !quickAddPreferences.preserveText })}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                quickAddPreferences.preserveText ? 'bg-blue-500' : 'bg-[var(--surface-3)]'
              }`}
            >
              <span className={`h-4 w-4 rounded-full bg-white transition-transform ${
                quickAddPreferences.preserveText ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </div>
      </div>

      {/* App badge setting */}
      <BadgeSettingsCard />

      {/* Navigation tab badge setting */}
      <NavBadgeSettingsCard />

      {/* Capture destination & inbox settings */}
      <CaptureDestinationSection />
      <InboxListsSection />

      {/* Dopamine Menu settings */}
      <DopamineMenuSettingsCard />
    </div>
  );
}

// --- Dopamine Menu Settings ------------------------------------------------

interface DopamineReward {
  id: string;
  emoji: string;
  label: string;
}

interface DopamineMenuSettingsData {
  enabled: boolean;
  threshold: number;
  rewards: DopamineReward[];
}

function DopamineMenuSettingsCard() {
  const [settings, setSettings] = useState<DopamineMenuSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingReward, setEditingReward] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editEmoji, setEditEmoji] = useState('');

  useEffect(() => {
    fetch('/api/settings/dopamine-menu')
      .then((r) => r.json())
      .then((data: DopamineMenuSettingsData) => setSettings(data))
      .catch((err) => { settingsLogger.error('Failed to fetch dopamine menu settings', { err }); });
  }, []);

  async function saveSettings(updates: Partial<DopamineMenuSettingsData>) {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/dopamine-menu', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      setSettings(data);
      toast.success('Dopamine menu settings saved');
    } catch {
      toast.error('Failed to save settings');
    }
    setSaving(false);
  }

  function startEditing(reward: DopamineReward) {
    setEditingReward(reward.id);
    setEditLabel(reward.label);
    setEditEmoji(reward.emoji);
  }

  function commitEdit() {
    if (!settings || !editingReward) return;
    const updated = settings.rewards.map((r) =>
      r.id === editingReward ? { ...r, emoji: editEmoji, label: editLabel } : r,
    );
    setEditingReward(null);
    void saveSettings({ rewards: updated });
  }

  function removeReward(id: string) {
    if (!settings) return;
    void saveSettings({ rewards: settings.rewards.filter((r) => r.id !== id) });
  }

  function addReward() {
    if (!settings) return;
    const newId = String(Date.now());
    void saveSettings({
      rewards: [...settings.rewards, { id: newId, emoji: '🎁', label: 'New reward' }],
    });
  }

  if (!settings) return null;

  return (
    <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
      {/* Enable toggle */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Zap size={18} className="text-[var(--text-muted)]" />
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Dopamine Menu</h3>
          </div>
          <p className="text-xs text-[var(--text-tertiary)]">
            Show a reward picker after completing tasks. Celebrate progress and take healthy breaks.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => void saveSettings({ enabled: !settings.enabled })}
          disabled={saving}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 flex-shrink-0 ${
            settings.enabled ? 'bg-blue-500' : 'bg-[var(--surface-3)]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200 ${
              settings.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {settings.enabled && (
        <>
          {/* Threshold */}
          <div className="mb-4">
            <label className="text-xs text-[var(--text-secondary)] mb-1 block">
              Trigger every N completions
            </label>
            <div className="flex items-center gap-2">
              <Select
                value={String(settings.threshold)}
                onValueChange={(v) => void saveSettings({ threshold: Number(v) })}
              >
                <SelectTrigger className="w-24 px-3 py-1.5 text-sm bg-[var(--surface-1)] border border-[var(--border)] rounded-md text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[3, 5, 7, 10, 15].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-[var(--text-tertiary)]">tasks</span>
            </div>
          </div>

          {/* Rewards list */}
          <div>
            <label className="text-xs text-[var(--text-secondary)] mb-2 block">Rewards</label>
            <div className="space-y-1.5">
              {settings.rewards.map((reward) => (
                <div
                  key={reward.id}
                  className="flex items-center gap-2 bg-[var(--surface-1)] rounded-md border border-[var(--border)] px-3 py-2 group"
                >
                  {editingReward === reward.id ? (
                    <>
                      <input
                        value={editEmoji}
                        onChange={(e) => setEditEmoji(e.target.value)}
                        className="w-8 text-center bg-transparent text-sm"
                        maxLength={4}
                      />
                      <input
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && commitEdit()}
                        className="flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none border-b border-blue-500/50"
                        autoFocus
                      />
                      <button
                        onClick={commitEdit}
                        className="text-xs text-blue-400 hover:text-blue-300"
                      >
                        <Check size={14} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-base">{reward.emoji}</span>
                      <span className="flex-1 text-sm text-[var(--text-secondary)]">
                        {reward.label}
                      </span>
                      <button
                        onClick={() => startEditing(reward)}
                        className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity"
                      >
                        <PenLine size={12} />
                      </button>
                      <button
                        onClick={() => removeReward(reward.id)}
                                                className="text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity"
                      >
                        <X size={12} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={addReward}
              className="mt-2 text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
            >
              <Plus size={12} /> Add reward
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- App Mode Section ------------------------------------------------------


export { GeneralSettingsSection };
