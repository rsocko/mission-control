'use client';

import { useCallback, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Rocket,
  Check,
  ChevronRight,
  Bell,
  Calendar,
  Link2,
  Clock,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/* ─────────────────────────── Types ─────────────────────────── */

export type OnboardingStep = 'welcome' | 'connect-tasks' | 'connect-content' | 'permissions' | 'preferences' | 'complete';

export interface OnboardingPreferences {
  workHoursStart: string;
  workHoursEnd: string;
  priorityDefault: 'ai' | 'manual';
  notificationsEnabled: boolean;
  calendarEnabled: boolean;
}

export interface MobileOnboardingProps {
  /** Callback when onboarding is completed or skipped */
  onComplete: (preferences?: OnboardingPreferences) => void;
  /** Whether the user already has connected accounts */
  hasConnectedAccounts?: boolean;
}

/* ─────────────────────────── Step Data ─────────────────────────── */

interface SetupStep {
  id: OnboardingStep;
  number: number;
  title: string;
  subtitle: string;
  status: 'done' | 'active' | 'pending';
}

/* ─────────────────────────── Component ─────────────────────────── */

/**
 * Mobile onboarding / first-run flow.
 * Matches iOS mockup Screen 14: step-based welcome with progress dots.
 *
 * Features:
 * - F-79: Welcome screen with app overview
 * - F-80: Permission requests (notifications, calendar access)
 * - F-81: Quick preference setup (work hours, priority defaults)
 * - F-82: Connect accounts prompt
 */
export function MobileOnboarding({ onComplete, hasConnectedAccounts = false }: MobileOnboardingProps) {
  const [currentStep, setCurrentStep] = useState<OnboardingStep>('welcome');
  const [preferences, setPreferences] = useState<OnboardingPreferences>({
    workHoursStart: '09:00',
    workHoursEnd: '17:00',
    priorityDefault: 'ai',
    notificationsEnabled: false,
    calendarEnabled: false,
  });
  const prefersReducedMotion = useReducedMotion() ?? false;

  const steps: SetupStep[] = [
    {
      id: 'welcome',
      number: 1,
      title: 'Account created',
      subtitle: 'Welcome to Mission Control',
      status: currentStep === 'welcome' ? 'active' : 'done',
    },
    {
      id: 'connect-tasks',
      number: 2,
      title: 'Connect your task sources',
      subtitle: 'MS To Do, GitHub Issues, or start fresh',
      status: getStepStatus('connect-tasks'),
    },
    {
      id: 'connect-content',
      number: 3,
      title: 'Connect content sources',
      subtitle: 'Reddit, GitHub Stars, YouTube, etc.',
      status: getStepStatus('connect-content'),
    },
    {
      id: 'permissions',
      number: 4,
      title: 'Enable notifications & calendar',
      subtitle: 'Stay on top of what matters',
      status: getStepStatus('permissions'),
    },
    {
      id: 'preferences',
      number: 5,
      title: 'Set your preferences',
      subtitle: 'Work hours & priority defaults',
      status: getStepStatus('preferences'),
    },
  ];

  function getStepStatus(stepId: OnboardingStep): 'done' | 'active' | 'pending' {
    const order: OnboardingStep[] = ['welcome', 'connect-tasks', 'connect-content', 'permissions', 'preferences', 'complete'];
    const currentIndex = order.indexOf(currentStep);
    const stepIndex = order.indexOf(stepId);
    if (stepIndex < currentIndex) return 'done';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  }

  const handleNext = useCallback(() => {
    const order: OnboardingStep[] = ['welcome', 'connect-tasks', 'connect-content', 'permissions', 'preferences', 'complete'];
    const idx = order.indexOf(currentStep);
    if (idx < order.length - 1) {
      const next = order[idx + 1];
      if (next === 'complete') {
        onComplete(preferences);
      } else {
        setCurrentStep(next);
      }
    }
  }, [currentStep, onComplete, preferences]);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  const progressDots = ['welcome', 'connect-tasks', 'connect-content', 'permissions', 'preferences'];
  const currentIndex = progressDots.indexOf(currentStep);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--surface-0)] sm:hidden">
      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-5 pt-12 pb-24">
        <AnimatePresence mode="wait" initial={!prefersReducedMotion}>
          {currentStep === 'welcome' && (
            <WelcomeStep key="welcome" onNext={handleNext} steps={steps} prefersReducedMotion={prefersReducedMotion} />
          )}
          {currentStep === 'connect-tasks' && (
            <ConnectTasksStep
              key="connect-tasks"
              onNext={handleNext}
              hasConnected={hasConnectedAccounts}
              prefersReducedMotion={prefersReducedMotion}
            />
          )}
          {currentStep === 'connect-content' && (
            <ConnectContentStep key="connect-content" onNext={handleNext} prefersReducedMotion={prefersReducedMotion} />
          )}
          {currentStep === 'permissions' && (
            <PermissionsStep
              key="permissions"
              onNext={handleNext}
              preferences={preferences}
              onUpdatePreferences={setPreferences}
              prefersReducedMotion={prefersReducedMotion}
            />
          )}
          {currentStep === 'preferences' && (
            <PreferencesStep
              key="preferences"
              onNext={handleNext}
              preferences={preferences}
              onUpdatePreferences={setPreferences}
              prefersReducedMotion={prefersReducedMotion}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Bottom: progress dots + skip */}
      <div className="fixed inset-x-0 bottom-0 px-5 pb-10 pt-4 bg-gradient-to-t from-[var(--surface-0)] via-[var(--surface-0)] to-transparent">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2">
          {progressDots.map((step, idx) => (
            <div
              key={step}
              className={cn(
                'h-2 rounded-full transition-all duration-300',
                idx < currentIndex
                  ? 'w-2 bg-emerald-400'
                  : idx === currentIndex
                    ? 'w-6 bg-[var(--accent)]'
                    : 'w-2 bg-[var(--text-muted)]/30'
              )}
            />
          ))}
        </div>

        {/* Skip option */}
        <button
          onClick={handleSkip}
          className="mt-4 w-full text-center text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors min-h-[44px]"
          aria-label="Skip onboarding setup"
        >
          Skip setup — I&apos;ll explore on my own
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Step Components ─────────────────────────── */

function WelcomeStep({ onNext, steps, prefersReducedMotion }: { onNext: () => void; steps: SetupStep[]; prefersReducedMotion: boolean }) {
  return (
    <motion.div
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, y: -20 }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.3 }}
    >
      {/* Hero */}
      <div className="flex flex-col items-center text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-[var(--accent)] to-violet-500 shadow-lg shadow-[var(--accent)]/30">
          <Rocket size={32} className="text-white" />
        </div>
        <h2 className="mt-5 text-[1.625rem] font-semibold text-[var(--text-primary)] leading-tight">
          Welcome to<br />Mission Control
        </h2>
        <p className="mt-3 max-w-[260px] text-sm leading-5 text-[var(--text-tertiary)]">
          Your AI-powered command center for tasks, content, and focus.
        </p>
      </div>

      {/* Setup steps preview */}
      <div className="mt-8 space-y-3">
        {steps.map((step) => (
          <div
            key={step.id}
            className={cn(
              'rounded-[18px] p-4 ring-1 ring-inset transition-all',
              step.status === 'done'
                ? 'bg-[var(--surface-1)] ring-emerald-400/20'
                : step.status === 'active'
                  ? 'bg-[var(--surface-1)] ring-[var(--accent)]/30 ring-2'
                  : 'bg-[var(--surface-1)] ring-[var(--border)] opacity-60'
            )}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full flex-shrink-0',
                  step.status === 'done'
                    ? 'bg-emerald-500/20'
                    : step.status === 'active'
                      ? 'bg-[var(--accent)]/20'
                      : 'bg-[var(--surface-2)]'
                )}
              >
                {step.status === 'done' ? (
                  <Check size={12} className="text-emerald-400" />
                ) : (
                  <span className={cn(
                    'text-xs font-bold',
                    step.status === 'active' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
                  )}>
                    {step.number}
                  </span>
                )}
              </div>
              <div className="flex-1">
                <p className={cn(
                  'text-sm font-medium',
                  step.status === 'done'
                    ? 'text-emerald-200'
                    : step.status === 'active'
                      ? 'text-[var(--text-primary)]'
                      : 'text-[var(--text-tertiary)]'
                )}>
                  {step.title}
                </p>
                <p className="text-xs text-[var(--text-muted)]">{step.subtitle}</p>
              </div>
              {step.status === 'active' && (
                <ChevronRight size={12} className="text-[var(--accent)]" />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Continue button */}
      <button
        onClick={onNext}
        className="mt-6 w-full rounded-xl bg-[var(--accent)] py-3.5 text-center text-base font-semibold text-white shadow-lg shadow-[var(--accent)]/20 hover:opacity-90 transition-opacity min-h-[44px]"
        aria-label="Get started"
      >
        Get Started
      </button>
    </motion.div>
  );
}

function ConnectTasksStep({
  onNext,
  hasConnected,
  prefersReducedMotion,
}: {
  onNext: () => void;
  hasConnected: boolean;
  prefersReducedMotion: boolean;
}) {
  const sources = [
    { name: 'Microsoft To Do', icon: '✓', connected: hasConnected },
    { name: 'GitHub Issues', icon: '⬡', connected: false },
    { name: 'Start fresh', icon: '✨', connected: false },
  ];

  return (
    <motion.div
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, y: -20 }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.3 }}
    >
      <div className="flex flex-col items-center text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--accent)]/15">
          <Layers size={28} className="text-[var(--accent)]" />
        </div>
        <h2 className="mt-4 text-[1.375rem] font-semibold text-[var(--text-primary)]">
          Connect Task Sources
        </h2>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          Where do your tasks live today?
        </p>
      </div>

      <div className="mt-6 space-y-3">
        {sources.map(source => (
          <button
            key={source.name}
            className={cn(
              'w-full flex items-center gap-3 rounded-[18px] p-4 ring-1 ring-inset transition-all min-h-[56px]',
              source.connected
                ? 'bg-[var(--surface-1)] ring-emerald-400/20'
                : 'bg-[var(--surface-1)] ring-[var(--border)] hover:ring-[var(--accent)]/30'
            )}
            aria-label={`Connect ${source.name}`}
          >
            <span className="text-xl">{source.icon}</span>
            <span className="flex-1 text-left text-sm font-medium text-[var(--text-primary)]">
              {source.name}
            </span>
            {source.connected ? (
              <span className="text-xs text-emerald-400">Connected</span>
            ) : (
              <ChevronRight size={14} className="text-[var(--text-muted)]" />
            )}
          </button>
        ))}
      </div>

      <button
        onClick={onNext}
        className="mt-6 w-full rounded-xl bg-[var(--accent)] py-3.5 text-center text-base font-semibold text-white shadow-lg shadow-[var(--accent)]/20 hover:opacity-90 transition-opacity min-h-[44px]"
        aria-label="Continue to next step"
      >
        Continue
      </button>
    </motion.div>
  );
}

function ConnectContentStep({ onNext, prefersReducedMotion }: { onNext: () => void; prefersReducedMotion: boolean }) {
  const sources = [
    { name: 'Reddit Saved', emoji: '🔴' },
    { name: 'GitHub Stars', emoji: '⭐' },
    { name: 'YouTube Watch Later', emoji: '▶️' },
    { name: 'Browser Bookmarks', emoji: '🔖' },
  ];

  return (
    <motion.div
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, y: -20 }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.3 }}
    >
      <div className="flex flex-col items-center text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-violet-500/15">
          <Link2 size={28} className="text-violet-400" />
        </div>
        <h2 className="mt-4 text-[1.375rem] font-semibold text-[var(--text-primary)]">
          Connect Content Sources
        </h2>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          Import content you&apos;ve saved across the web.
        </p>
      </div>

      <div className="mt-6 space-y-3">
        {sources.map(source => (
          <button
            key={source.name}
            className="w-full flex items-center gap-3 rounded-[18px] p-4 bg-[var(--surface-1)] ring-1 ring-inset ring-[var(--border)] hover:ring-[var(--accent)]/30 transition-all min-h-[56px]"
            aria-label={`Connect ${source.name}`}
          >
            <span className="text-xl">{source.emoji}</span>
            <span className="flex-1 text-left text-sm font-medium text-[var(--text-primary)]">
              {source.name}
            </span>
            <ChevronRight size={14} className="text-[var(--text-muted)]" />
          </button>
        ))}
      </div>

      <button
        onClick={onNext}
        className="mt-6 w-full rounded-xl bg-[var(--accent)] py-3.5 text-center text-base font-semibold text-white shadow-lg shadow-[var(--accent)]/20 hover:opacity-90 transition-opacity min-h-[44px]"
        aria-label="Continue to next step"
      >
        Continue
      </button>
    </motion.div>
  );
}

function PermissionsStep({
  onNext,
  preferences,
  onUpdatePreferences,
  prefersReducedMotion,
}: {
  onNext: () => void;
  preferences: OnboardingPreferences;
  onUpdatePreferences: (prefs: OnboardingPreferences) => void;
  prefersReducedMotion: boolean;
}) {
  const handleToggleNotifications = useCallback(() => {
    onUpdatePreferences({ ...preferences, notificationsEnabled: !preferences.notificationsEnabled });
  }, [preferences, onUpdatePreferences]);

  const handleToggleCalendar = useCallback(() => {
    onUpdatePreferences({ ...preferences, calendarEnabled: !preferences.calendarEnabled });
  }, [preferences, onUpdatePreferences]);

  return (
    <motion.div
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, y: -20 }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.3 }}
    >
      <div className="flex flex-col items-center text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/15">
          <Bell size={28} className="text-amber-400" />
        </div>
        <h2 className="mt-4 text-[1.375rem] font-semibold text-[var(--text-primary)]">
          Permissions
        </h2>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          Enable these to get the most out of Mission Control.
        </p>
      </div>

      <div className="mt-6 space-y-3">
        {/* Notifications permission */}
        <button
          onClick={handleToggleNotifications}
          className={cn(
            'w-full flex items-center gap-3 rounded-[18px] p-4 ring-1 ring-inset transition-all min-h-[56px]',
            preferences.notificationsEnabled
              ? 'bg-[var(--surface-1)] ring-emerald-400/20'
              : 'bg-[var(--surface-1)] ring-[var(--border)]'
          )}
          aria-label="Toggle push notifications"
          aria-pressed={preferences.notificationsEnabled}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15 flex-shrink-0">
            <Bell size={18} className="text-amber-400" />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-medium text-[var(--text-primary)]">Push Notifications</p>
            <p className="text-xs text-[var(--text-muted)]">Morning prompts, overdue alerts, triage nudges</p>
          </div>
          <div className={cn(
            'w-12 h-7 rounded-full p-0.5 transition-colors',
            preferences.notificationsEnabled ? 'bg-emerald-500' : 'bg-[var(--surface-2)]'
          )}>
            <div className={cn(
              'w-6 h-6 rounded-full bg-white shadow transition-transform',
              preferences.notificationsEnabled ? 'translate-x-5' : 'translate-x-0'
            )} />
          </div>
        </button>

        {/* Calendar permission */}
        <button
          onClick={handleToggleCalendar}
          className={cn(
            'w-full flex items-center gap-3 rounded-[18px] p-4 ring-1 ring-inset transition-all min-h-[56px]',
            preferences.calendarEnabled
              ? 'bg-[var(--surface-1)] ring-emerald-400/20'
              : 'bg-[var(--surface-1)] ring-[var(--border)]'
          )}
          aria-label="Toggle calendar access"
          aria-pressed={preferences.calendarEnabled}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-500/15 flex-shrink-0">
            <Calendar size={18} className="text-sky-400" />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-medium text-[var(--text-primary)]">Calendar Access</p>
            <p className="text-xs text-[var(--text-muted)]">Show time blocks, respect busy hours</p>
          </div>
          <div className={cn(
            'w-12 h-7 rounded-full p-0.5 transition-colors',
            preferences.calendarEnabled ? 'bg-emerald-500' : 'bg-[var(--surface-2)]'
          )}>
            <div className={cn(
              'w-6 h-6 rounded-full bg-white shadow transition-transform',
              preferences.calendarEnabled ? 'translate-x-5' : 'translate-x-0'
            )} />
          </div>
        </button>
      </div>

      <button
        onClick={onNext}
        className="mt-6 w-full rounded-xl bg-[var(--accent)] py-3.5 text-center text-base font-semibold text-white shadow-lg shadow-[var(--accent)]/20 hover:opacity-90 transition-opacity min-h-[44px]"
        aria-label="Continue to preferences"
      >
        Continue
      </button>
    </motion.div>
  );
}

function PreferencesStep({
  onNext,
  preferences,
  onUpdatePreferences,
  prefersReducedMotion,
}: {
  onNext: () => void;
  preferences: OnboardingPreferences;
  onUpdatePreferences: (prefs: OnboardingPreferences) => void;
  prefersReducedMotion: boolean;
}) {
  return (
    <motion.div
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, y: -20 }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.3 }}
    >
      <div className="flex flex-col items-center text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15">
          <Clock size={28} className="text-emerald-400" />
        </div>
        <h2 className="mt-4 text-[1.375rem] font-semibold text-[var(--text-primary)]">
          Your Preferences
        </h2>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          Help Houston understand your schedule.
        </p>
      </div>

      <div className="mt-6 space-y-4">
        {/* Work hours */}
        <div className="rounded-[18px] p-4 bg-[var(--surface-1)] ring-1 ring-inset ring-[var(--border)]">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)] mb-3">
            Work Hours
          </p>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs text-[var(--text-muted)]">Start</label>
              <input
                type="time"
                value={preferences.workHoursStart}
                onChange={e => onUpdatePreferences({ ...preferences, workHoursStart: e.target.value })}
                className="mt-1 w-full rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] ring-1 ring-inset ring-[var(--border)] outline-none [color-scheme:dark]"
                aria-label="Work hours start time"
              />
            </div>
            <span className="text-[var(--text-muted)] mt-4">to</span>
            <div className="flex-1">
              <label className="text-xs text-[var(--text-muted)]">End</label>
              <input
                type="time"
                value={preferences.workHoursEnd}
                onChange={e => onUpdatePreferences({ ...preferences, workHoursEnd: e.target.value })}
                className="mt-1 w-full rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] ring-1 ring-inset ring-[var(--border)] outline-none [color-scheme:dark]"
                aria-label="Work hours end time"
              />
            </div>
          </div>
        </div>

        {/* Priority mode */}
        <div className="rounded-[18px] p-4 bg-[var(--surface-1)] ring-1 ring-inset ring-[var(--border)]">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)] mb-3">
            Priority Assignment
          </p>
          <div className="space-y-2">
            <button
              onClick={() => onUpdatePreferences({ ...preferences, priorityDefault: 'ai' })}
              className={cn(
                'w-full flex items-center gap-3 rounded-xl p-3 transition-all min-h-[44px]',
                preferences.priorityDefault === 'ai'
                  ? 'bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]/30'
                  : 'bg-[var(--surface-2)]'
              )}
              aria-pressed={preferences.priorityDefault === 'ai'}
            >
              <Rocket size={16} className={preferences.priorityDefault === 'ai' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
              <div className="text-left flex-1">
                <p className="text-sm font-medium text-[var(--text-primary)]">AI-powered (recommended)</p>
                <p className="text-xs text-[var(--text-muted)]">Houston suggests priorities based on context</p>
              </div>
            </button>
            <button
              onClick={() => onUpdatePreferences({ ...preferences, priorityDefault: 'manual' })}
              className={cn(
                'w-full flex items-center gap-3 rounded-xl p-3 transition-all min-h-[44px]',
                preferences.priorityDefault === 'manual'
                  ? 'bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]/30'
                  : 'bg-[var(--surface-2)]'
              )}
              aria-pressed={preferences.priorityDefault === 'manual'}
            >
              <Layers size={16} className={preferences.priorityDefault === 'manual' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
              <div className="text-left flex-1">
                <p className="text-sm font-medium text-[var(--text-primary)]">Manual</p>
                <p className="text-xs text-[var(--text-muted)]">You set every priority yourself</p>
              </div>
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={onNext}
        className="mt-6 w-full rounded-xl bg-gradient-to-r from-[var(--accent)] to-violet-500 py-3.5 text-center text-base font-semibold text-white shadow-lg shadow-[var(--accent)]/20 hover:opacity-90 transition-opacity min-h-[44px]"
        aria-label="Finish setup and enter app"
      >
        🚀 Launch Mission Control
      </button>
    </motion.div>
  );
}
