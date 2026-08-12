'use client';

/**
 * Shared motion animation variants and utilities for Mission Control.
 * Uses the `motion` library (formerly Framer Motion).
 *
 * Design principles (from UI-POLISH-PRINCIPLES):
 * - Split and stagger enters: ~80ms stagger, combine opacity + blur + translateY
 * - Subtle exits: small translateY(-8px), shorter duration than enters
 * - Interruptible animations: spring-based for interactive, tween for sequences
 * - Never transition: all — always specify exact properties
 * - Skip page-load animations: initial={false} for default-state elements
 */

import type { Variants, Transition } from 'motion/react';

// ─── Transitions ────────────────────────────────────────────────────────────

export const springSnappy: Transition = {
  type: 'spring',
  stiffness: 500,
  damping: 30,
  mass: 1,
};

export const springGentle: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 25,
  mass: 0.8,
};

export const tweenFast: Transition = {
  type: 'tween',
  duration: 0.15,
  ease: 'easeOut',
};

export const tweenBase: Transition = {
  type: 'tween',
  duration: 0.2,
  ease: [0.25, 0.1, 0.25, 1],
};

export const tweenSlow: Transition = {
  type: 'tween',
  duration: 0.3,
  ease: [0.25, 0.1, 0.25, 1],
};

// ─── Stagger Container Variants ─────────────────────────────────────────────

export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.05,
    },
  },
};

export const staggerContainerSlow: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.1,
    },
  },
};

// ─── List Item Variants ─────────────────────────────────────────────────────

export const fadeSlideUp: Variants = {
  hidden: {
    opacity: 0,
    y: 8,
    filter: 'blur(4px)',
  },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 25,
    },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: { duration: 0.15 },
  },
};

export const fadeSlideIn: Variants = {
  hidden: {
    opacity: 0,
    x: -12,
    filter: 'blur(4px)',
  },
  show: {
    opacity: 1,
    x: 0,
    filter: 'blur(0px)',
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 25,
    },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { duration: 0.2 },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.1 },
  },
};

// ─── Card / Panel Variants ──────────────────────────────────────────────────

export const scaleIn: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.95,
    filter: 'blur(4px)',
  },
  show: {
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 28,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    transition: { duration: 0.12 },
  },
};

// ─── Modal / Overlay Variants ───────────────────────────────────────────────

export const modalOverlay: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

export const modalContent: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.96,
    y: 10,
  },
  show: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 28,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 5,
    transition: { duration: 0.12 },
  },
};

// ─── Dropdown / Popover Variants ────────────────────────────────────────────

export const dropdownVariants: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.95,
    y: -4,
  },
  show: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 30,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: -4,
    transition: { duration: 0.1 },
  },
};

// ─── Kanban / Layout Animations ─────────────────────────────────────────────

export const kanbanColumn: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 300,
      damping: 25,
      staggerChildren: 0.04,
    },
  },
};

export const kanbanCard: Variants = {
  hidden: { opacity: 0, y: 6, scale: 0.98 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 25,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: { duration: 0.15 },
  },
};

// ─── Stat Card Variants ─────────────────────────────────────────────────────

export const statCardVariants: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.97 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 350,
      damping: 25,
    },
  },
};

// ─── Progress / Number Counter ──────────────────────────────────────────────

export const numberPop: Variants = {
  hidden: { opacity: 0, scale: 0.5 },
  show: {
    opacity: 1,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 15,
    },
  },
};

// ─── Press Scale (for buttons) ──────────────────────────────────────────────

export const pressScale = {
  whileTap: { scale: 0.96 },
  transition: springSnappy,
};

// ─── Completion Celebration ─────────────────────────────────────────────────

export const completionBurst: Variants = {
  idle: { scale: 1, opacity: 1 },
  celebrate: {
    scale: [1, 1.3, 1],
    opacity: 1,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 15,
      duration: 0.4,
    },
  },
};

export const completionParticle: Variants = {
  hidden: { opacity: 0, scale: 0, y: 0 },
  show: {
    opacity: [1, 1, 0],
    scale: [0.5, 1, 0.8],
    y: [0, -20, -30],
    transition: {
      duration: 0.6,
      ease: 'easeOut',
    },
  },
};

// ─── WIP Limit Warning ─────────────────────────────────────────────────────

export const wipWarningPulse: Variants = {
  idle: { boxShadow: '0 0 0 0 rgba(239, 68, 68, 0)' },
  warning: {
    boxShadow: [
      '0 0 0 0 rgba(239, 68, 68, 0.2)',
      '0 0 0 6px rgba(239, 68, 68, 0)',
    ],
    transition: {
      duration: 1.5,
      ease: 'easeInOut',
      repeat: Infinity,
    },
  },
};

// ─── One Thing Celebration (enhanced completion) ────────────────────────────

export const oneThingCelebration: Variants = {
  idle: {
    scale: 1,
    boxShadow: '0 0 0 0 rgba(16, 185, 129, 0)',
  },
  celebrate: {
    scale: [1, 1.02, 0.98, 1],
    boxShadow: [
      '0 0 0 0 rgba(16, 185, 129, 0.4)',
      '0 0 0 12px rgba(16, 185, 129, 0)',
    ],
    transition: {
      scale: {
        type: 'spring',
        stiffness: 400,
        damping: 12,
        duration: 0.5,
      },
      boxShadow: {
        duration: 0.8,
        ease: 'easeOut',
      },
    },
  },
};

export const oneThingConfetti: Variants = {
  hidden: { opacity: 0, scale: 0, rotate: 0 },
  show: (i: number) => ({
    opacity: [1, 1, 0],
    scale: [0, 1.2, 0.6],
    rotate: [0, (i % 2 === 0 ? 1 : -1) * (120 + i * 30)],
    x: [0, (i % 2 === 0 ? 1 : -1) * (20 + i * 12)],
    y: [0, -(30 + i * 8), 10],
    transition: {
      duration: 0.8,
      delay: i * 0.06,
      ease: 'easeOut',
    },
  }),
};

export const oneThingGlow: Variants = {
  idle: {
    boxShadow: '0 0 0 0 rgba(16, 185, 129, 0), inset 0 0 0 0 rgba(16, 185, 129, 0)',
  },
  glow: {
    boxShadow: [
      '0 0 20px 4px rgba(16, 185, 129, 0.15), inset 0 0 8px 0 rgba(16, 185, 129, 0.05)',
      '0 0 0 0 rgba(16, 185, 129, 0), inset 0 0 0 0 rgba(16, 185, 129, 0)',
    ],
    transition: {
      duration: 2,
      ease: 'easeInOut',
      repeat: Infinity,
    },
  },
};

// ─── Drawer / Slide-out Panel ───────────────────────────────────────────────

export const drawerSlideIn: Variants = {
  hidden: {
    x: '-100%',
  },
  show: {
    x: 0,
    transition: {
      type: 'spring',
      stiffness: 400,
      damping: 34,
      mass: 0.8,
    },
  },
  exit: {
    x: '-100%',
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 35,
      mass: 0.8,
    },
  },
};

export const drawerOverlay: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.25, ease: 'easeOut' } },
  exit: { opacity: 0, transition: { duration: 0.2, ease: 'easeIn' } },
};

// ─── Search Highlight ───────────────────────────────────────────────────────

export const searchDim: Variants = {
  visible: { opacity: 1, filter: 'blur(0px)' },
  dimmed: {
    opacity: 0.3,
    filter: 'blur(1px)',
    transition: { duration: 0.2 },
  },
};

// ─── Snooze Fade Out ────────────────────────────────────────────────────────

export const snoozeFadeOut: Variants = {
  visible: {
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
  },
  snoozed: {
    opacity: 0,
    scale: 0.95,
    filter: 'blur(4px)',
    transition: {
      duration: 0.4,
      ease: [0.25, 0.1, 0.25, 1],
    },
  },
};
