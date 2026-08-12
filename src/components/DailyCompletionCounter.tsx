'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2 } from 'lucide-react';
import { completionBurst, springSnappy } from '@/lib/motion';

export function DailyCompletionCounter() {
  const [count, setCount] = useState(0);
  const [celebrating, setCelebrating] = useState(false);
  const prevCount = useRef(0);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch('/api/daily-completions');
      const data = await res.json();
      const newCount = Number(data.count || 0);
      if (newCount > prevCount.current && prevCount.current > 0) {
        setCelebrating(true);
        setTimeout(() => setCelebrating(false), 600);
      }
      prevCount.current = newCount;
      setCount(newCount);
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchCount();
    // Poll every 30s to pick up completions from other views
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, [fetchCount]);

  // Listen for custom completion events from task actions
  useEffect(() => {
    function handleCompletion() {
      fetchCount();
    }
    window.addEventListener('mc:task-completed', handleCompletion);
    return () => window.removeEventListener('mc:task-completed', handleCompletion);
  }, [fetchCount]);

  return (
    <motion.div
      className="relative flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--surface-2)] border border-[var(--border)] cursor-default select-none"
      variants={completionBurst}
      animate={celebrating ? 'celebrate' : 'idle'}
      title={`${count} task${count !== 1 ? 's' : ''} completed today`}
    >
      <CheckCircle2 size={14} className="text-[var(--success)]" />
      <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
        {count}
      </span>

      {/* Celebration particles */}
      <AnimatePresence>
        {celebrating && (
          <>
            {[...Array(6)].map((_, i) => (
              <motion.span
                key={i}
                className={`absolute top-1/2 left-1/2 h-1.5 w-1.5 rounded-full ${
                  ['bg-green-500', 'bg-blue-500', 'bg-amber-500', 'bg-pink-500', 'bg-violet-500', 'bg-cyan-500'][i]
                }`}
                initial={{ opacity: 0, scale: 0, x: 0, y: 0 }}
                animate={{
                  opacity: [1, 1, 0],
                  scale: [0.5, 1, 0.6],
                  x: [0, Math.cos((i * Math.PI * 2) / 6) * 20],
                  y: [0, Math.sin((i * Math.PI * 2) / 6) * 20],
                }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
            ))}
          </>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
