'use client';

import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Timer, Play, Pause, RotateCcw, Target, Clock, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTimer, type TimerMode } from '@/lib/hooks/useTimer';
import { scaleIn } from '@/lib/motion';
import { uiLogger } from '@/lib/client-logger';

// ─── Presets ────────────────────────────────────────────────────────────────

const FOCUS_PRESETS = [
  { label: '15m', seconds: 15 * 60 },
  { label: '25m', seconds: 25 * 60 },
  { label: '45m', seconds: 45 * 60 },
  { label: '60m', seconds: 60 * 60 },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getUrgencyClass(remaining: number, total: number): string {
  if (total === 0) return '';
  const ratio = remaining / total;
  if (ratio <= 0.1) return 'text-red-400 animate-pulse';
  if (ratio <= 0.25) return 'text-red-400';
  if (ratio <= 0.5) return 'text-amber-400';
  return 'text-[var(--text-primary)]';
}

/** Request notification permission if not yet decided. */
function ensureNotificationPermission() {
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch((err) => { uiLogger.warn('Notification permission request failed', { err }); });
  }
}

/** Play a short sine beep via Web Audio, then close the context. */
function playCompletionBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.stop(ctx.currentTime + 0.6);
    osc.onended = () => ctx.close();
  } catch { /* audio not available */ }
}

// ─── Ring Progress ──────────────────────────────────────────────────────────

function ProgressRing({ progress, size = 120, strokeWidth = 4, urgency }: {
  progress: number;
  size?: number;
  strokeWidth?: number;
  urgency: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - progress);

  const strokeColor = urgency.includes('red')
    ? 'var(--danger)'
    : urgency.includes('amber')
      ? 'var(--warning)'
      : 'var(--accent)';

  return (
    <svg width={size} height={size} className="rotate-[-90deg]" role="img" aria-label={`Timer progress: ${Math.round(progress * 100)}%`}>
      {/* Background ring */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--surface-2)"
        strokeWidth={strokeWidth}
      />
      {/* Progress ring */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-[stroke-dashoffset] duration-1000 ease-linear"
      />
    </svg>
  );
}

// ─── Timer Panel Component ──────────────────────────────────────────────────

interface TimerPanelProps {
  /** Optional task title to display */
  taskTitle?: string;
  /** Optional deadline ISO string for deadline mode */
  taskDeadline?: string;
  /** Callback when timer completes (business logic only — UI feedback is handled internally) */
  onComplete?: () => void;
}

export function TimerPanel({ taskTitle, taskDeadline, onComplete }: TimerPanelProps) {
  const [mode, setMode] = useState<TimerMode>(taskDeadline ? 'deadline' : 'focus');
  const [focusDuration, setFocusDuration] = useState(25 * 60);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const handleComplete = useCallback(() => {
    const title = mode === 'focus' ? 'Focus session complete!' : 'Deadline reached!';
    const body = mode === 'focus'
      ? 'Great work — time for a break!'
      : taskTitle || 'Time\'s up';

    // Single in-app toast (only source of UI feedback for completion)
    if (mode === 'focus') {
      toast.success(title, { description: body });
    } else {
      toast(title, { description: body });
    }

    // Browser notification (works even when tab is in background)
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, icon: '/favicon.ico' }); } catch { /* ignore */ }
    }

    playCompletionBeep();

    // Business-only callback — caller should NOT duplicate UI feedback
    onCompleteRef.current?.();
  }, [mode, taskTitle]);

  const timer = useTimer({
    mode,
    duration: focusDuration,
    deadline: mode === 'deadline' ? taskDeadline : undefined,
    onComplete: handleComplete,
    persistKey: 'mission-control:timer',
  });

  const urgencyClass = getUrgencyClass(timer.remaining, timer.total);

  // Request notification permission on first start (not on mount)
  const handleStart = useCallback(() => {
    ensureNotificationPermission();
    timer.start();
  }, [timer]);

  return (
    <section className="bg-[var(--surface-1)] rounded-lg border border-[var(--border)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2">
          <Timer size={14} className="text-blue-400" />
          <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--text-tertiary)] font-semibold">
            Timer
          </h3>
        </div>
        {/* Mode Toggle */}
        <div className="flex bg-[var(--surface-2)] rounded-md p-0.5" role="tablist" aria-label="Timer mode">
          <button
            onClick={() => { setMode('focus'); timer.reset(); }}
            role="tab"
            aria-selected={mode === 'focus'}
            className={`px-2.5 py-1 text-xs rounded transition-[background-color,color,box-shadow] duration-150 flex items-center gap-1 ${
              mode === 'focus'
                ? 'bg-[var(--surface-1)] shadow-sm font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
            }`}
          >
            <Clock size={10} />
            Focus
          </button>
          <button
            onClick={() => { setMode('deadline'); timer.reset(); }}
            disabled={!taskDeadline}
            role="tab"
            aria-selected={mode === 'deadline'}
            className={`px-2.5 py-1 text-xs rounded transition-[background-color,color,box-shadow] duration-150 flex items-center gap-1 ${
              mode === 'deadline'
                ? 'bg-[var(--surface-1)] shadow-sm font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
            } ${!taskDeadline ? 'opacity-40 cursor-not-allowed' : ''}`}
            title={!taskDeadline ? 'No deadline set on task' : 'Countdown to deadline'}
          >
            <Target size={10} />
            Deadline
          </button>
        </div>
      </div>

      {/* Timer Display */}
      <div className="flex flex-col items-center py-5 px-4">
        {/* Task title */}
        {taskTitle && (
          <p className="text-xs text-[var(--text-secondary)] mb-3 truncate max-w-full text-center">
            {taskTitle}
          </p>
        )}

        {/* Ring + Time */}
        <div className="relative flex items-center justify-center">
          <ProgressRing
            progress={timer.progress}
            size={120}
            strokeWidth={4}
            urgency={urgencyClass}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center" aria-live="polite" aria-atomic="true">
            <span className={`text-2xl font-mono font-bold tabular-nums ${urgencyClass}`} aria-label={`${formatTime(timer.remaining)} remaining`}>
              {formatTime(timer.remaining)}
            </span>
            {timer.state === 'completed' && (
              <span className="text-xs text-emerald-400 font-medium mt-0.5">Done!</span>
            )}
            {mode === 'deadline' && timer.state === 'running' && timer.remaining <= timer.total * 0.1 && (
              <AlertTriangle size={12} className="text-red-400 mt-1 animate-pulse" />
            )}
          </div>
        </div>

        {/* Focus presets (only in focus mode when idle) */}
        <AnimatePresence>
          {mode === 'focus' && timer.state === 'idle' && (
            <motion.div
              variants={scaleIn}
              initial="hidden"
              animate="show"
              exit="exit"
              className="flex gap-1.5 mt-4"
            >
              {FOCUS_PRESETS.map((preset) => (
                <button
                  key={preset.seconds}
                  onClick={() => setFocusDuration(preset.seconds)}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-[background-color,border-color,color] duration-150 ${
                    focusDuration === preset.seconds
                      ? 'bg-blue-900/30 border-blue-500/50 text-blue-400 font-medium'
                      : 'border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Controls */}
        <div className="flex items-center gap-2 mt-4">
          {timer.state === 'idle' && (
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={handleStart}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-[background-color] duration-150"
            >
              <Play size={12} />
              Start
            </motion.button>
          )}

          {timer.state === 'running' && (
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={timer.pause}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-[var(--surface-2)] text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-[background-color] duration-150 border border-[var(--border)]"
            >
              <Pause size={12} />
              Pause
            </motion.button>
          )}

          {timer.state === 'paused' && (
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={timer.resume}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-[background-color] duration-150"
            >
              <Play size={12} />
              Resume
            </motion.button>
          )}

          {(timer.state === 'paused' || timer.state === 'completed') && (
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={timer.reset}
              className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-[background-color,color] duration-150"
            >
              <RotateCcw size={12} />
              Reset
            </motion.button>
          )}
        </div>
      </div>
    </section>
  );
}
