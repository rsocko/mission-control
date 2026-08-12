'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

const PARTICLE_COUNT = 6;
const PARTICLE_COLORS = [
  '#10b981', // emerald-500
  '#34d399', // emerald-400
  '#6ee7b7', // emerald-300
  '#3b82f6', // blue-500
  '#60a5fa', // blue-400
  '#a78bfa', // violet-400
];

// Pre-compute particle positions (static data, no need to recalculate per render)
const PARTICLES = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
  const angle = (i / PARTICLE_COUNT) * 360;
  const rad = (angle * Math.PI) / 180;
  const distance = 16 + (i % 2) * 6;
  return {
    key: i,
    color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
    x: Math.cos(rad) * distance,
    y: Math.sin(rad) * distance,
  };
});

// --- Settings hook -----------------------------------------------------------

export const COMPLETION_ANIMATION_KEY = 'mission-control:completion-animation';

function subscribeToAnimationSetting(callback: () => void) {
  const handler = () => callback();
  window.addEventListener('mission-control:completion-animation-change', handler);
  return () => window.removeEventListener('mission-control:completion-animation-change', handler);
}

function getAnimationSnapshot(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(COMPLETION_ANIMATION_KEY) !== 'false';
}

// SSR-safe snapshot — default to enabled
const serverSnapshot = () => true;

/** Reactive hook: returns whether completion animations are enabled. */
export function useCompletionAnimation(): boolean {
  return useSyncExternalStore(subscribeToAnimationSetting, getAnimationSnapshot, () => serverSnapshot());
}

/** Toggle helper for use in settings UI. */
export function setCompletionAnimationEnabled(enabled: boolean) {
  localStorage.setItem(COMPLETION_ANIMATION_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent('mission-control:completion-animation-change', { detail: enabled }));
}

// --- Component ---------------------------------------------------------------

/**
 * Wraps a completion checkbox and fires a subtle particle burst + scale pop
 * when `celebrating` transitions from false → true.
 *
 * Disabled when:
 * - User has toggled off in Settings → General
 * - OS prefers-reduced-motion is active (particles/ring skipped; scale-pop skipped)
 */
export function CompletionBurst({
  celebrating,
  children,
}: {
  celebrating: boolean;
  children: React.ReactNode;
}) {
  const prefersReduced = useReducedMotion();
  const enabled = useCompletionAnimation();
  const [showParticles, setShowParticles] = useState(false);
  const prevCelebrating = useRef(false);

  useEffect(() => {
    if (celebrating && !prevCelebrating.current) {
      setShowParticles(true);
      const timer = setTimeout(() => setShowParticles(false), 700);
      prevCelebrating.current = celebrating;
      return () => clearTimeout(timer);
    }
    prevCelebrating.current = celebrating;
  }, [celebrating]);

  // Animations fully disabled — render children bare
  if (!enabled) {
    return <>{children}</>;
  }

  const animateEffects = !prefersReduced;

  return (
    <div className="relative flex items-center justify-center">
      {/* Scale-pop wrapper — skipped for reduced motion */}
      {animateEffects ? (
        <motion.div
          animate={
            celebrating
              ? { scale: [1, 1.25, 1], transition: { duration: 0.35, ease: 'easeOut' } }
              : { scale: 1 }
          }
        >
          {children}
        </motion.div>
      ) : (
        children
      )}

      {/* Particle burst */}
      {animateEffects && (
        <AnimatePresence>
          {showParticles &&
            PARTICLES.map((p) => (
              <motion.span
                key={p.key}
                className="absolute h-1 w-1 rounded-full pointer-events-none"
                style={{ backgroundColor: p.color }}
                initial={{ opacity: 0, scale: 0, x: 0, y: 0 }}
                animate={{
                  opacity: [1, 1, 0],
                  scale: [0.5, 1, 0.6],
                  x: [0, p.x],
                  y: [0, p.y],
                }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.5,
                  ease: 'easeOut',
                  delay: p.key * 0.03,
                }}
              />
            ))}
        </AnimatePresence>
      )}

      {/* Ring burst */}
      {animateEffects && (
        <AnimatePresence>
          {showParticles && (
            <motion.span
              className="absolute h-5 w-5 rounded-full border-2 border-green-400 pointer-events-none"
              initial={{ opacity: 0.6, scale: 1 }}
              animate={{ opacity: 0, scale: 2.2 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
            />
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
