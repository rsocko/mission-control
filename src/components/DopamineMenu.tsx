'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { modalOverlay, modalContent } from '@/lib/motion';
import { uiLogger } from '@/lib/client-logger';

interface DopamineReward {
  id: string;
  emoji: string;
  label: string;
}

interface DopamineMenuSettings {
  enabled: boolean;
  threshold: number;
  rewards: DopamineReward[];
}

/**
 * Dopamine Menu — reward picker overlay shown after every N task completions.
 * Listens for `mc:task-completed` events, fetches daily count from the API,
 * and pops the overlay whenever count crosses a threshold multiple.
 */
export function DopamineMenu() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<DopamineMenuSettings | null>(null);
  const [todayCount, setTodayCount] = useState(0);
  const [pickedReward, setPickedReward] = useState<DopamineReward | null>(null);
  const lastTriggeredAt = useRef(0); // tracks which threshold multiple we last triggered
  const initialized = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch settings on mount
  useEffect(() => {
    fetch('/api/settings/dopamine-menu')
      .then((r) => r.json())
      .then((data: DopamineMenuSettings) => setSettings(data))
      .catch((err) => { uiLogger.error('Failed to fetch dopamine menu settings', { err }); });
  }, []);

  // Fetch today's completion count
  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch('/api/daily-completions');
      const data = await res.json();
      return Number(data.count || 0);
    } catch {
      return 0;
    }
  }, []);

  // Initialize watermark and listen for task completions in a single effect
  // to avoid the race where the listener fires before the watermark is set.
  useEffect(() => {
    if (!settings?.enabled) return;

    const { threshold } = settings;
    initialized.current = false;

    // Set the watermark before registering the listener
    fetchCount().then((count) => {
      setTodayCount(count);
      lastTriggeredAt.current = Math.floor(count / threshold);
      initialized.current = true;
    });

    async function handleCompletion() {
      // Don't trigger until the watermark is set
      if (!initialized.current) return;

      const count = await fetchCount();
      setTodayCount(count);

      const currentMultiple = Math.floor(count / threshold);
      if (count > 0 && count % threshold === 0 && currentMultiple > lastTriggeredAt.current) {
        lastTriggeredAt.current = currentMultiple;
        setPickedReward(null);
        setOpen(true);
      }
    }

    window.addEventListener('mc:task-completed', handleCompletion);
    return () => window.removeEventListener('mc:task-completed', handleCompletion);
  }, [fetchCount, settings]);

  // Clean up close timer on unmount
  useEffect(() => {
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  }, []);

  function handlePickReward(reward: DopamineReward) {
    setPickedReward(reward);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 1200);
  }

  if (!settings?.enabled) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
          variants={modalOverlay}
          initial="hidden"
          animate="show"
          exit="exit"
          onClick={() => setOpen(false)}
        >
          <motion.div
            className="relative bg-[var(--surface-1)] rounded-xl shadow-xl border border-[var(--border)] p-5 max-w-sm w-full mx-6"
            variants={modalContent}
            initial="hidden"
            animate="show"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={() => setOpen(false)}
              className="absolute top-3 right-3 w-8 h-8 rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)] transition-colors"
            >
              <X size={16} className="mx-auto" />
            </button>

            {/* Header */}
            <h2 className="text-lg font-semibold text-[var(--text-primary)] pr-8">
              🎉 Nice — {todayCount} task{todayCount !== 1 ? 's' : ''} done today!
            </h2>
            <p className="text-sm text-[var(--text-tertiary)] mt-1">
              {pickedReward ? `Enjoy your ${pickedReward.label.toLowerCase()}!` : "You've earned a reward. Pick one:"}
            </p>

            {/* Reward grid */}
            <div className="grid grid-cols-3 gap-2 mt-4">
              {settings.rewards.map((reward) => (
                <button
                  key={reward.id}
                  onClick={() => handlePickReward(reward)}
                  className={`rounded-lg p-3 text-center border text-sm transition-[background-color,border-color,transform,box-shadow] duration-150 ${
                    pickedReward?.id === reward.id
                      ? 'bg-blue-500/20 border-blue-500/50 scale-105 ring-2 ring-blue-500/30'
                      : 'bg-[var(--surface-2)] hover:bg-blue-500/10 border-[var(--border)] hover:border-blue-500/30'
                  }`}
                >
                  <div className="text-lg">{reward.emoji}</div>
                  <div className="mt-1 text-[var(--text-secondary)]">{reward.label}</div>
                </button>
              ))}
            </div>

            {/* Footer */}
            <p className="text-xs text-[var(--text-muted)] mt-4">
              Triggers every {settings.threshold} completions · Change in Settings → General
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
