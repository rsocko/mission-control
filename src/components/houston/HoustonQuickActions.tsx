'use client';

import { motion } from 'motion/react';
import { Sparkles, CalendarDays, ListTodo, Zap, Brain } from 'lucide-react';
import type { ReactNode } from 'react';

export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
  icon: ReactNode;
}

const defaultActions: QuickAction[] = [
  {
    id: 'whats-next',
    label: 'What should I do next?',
    prompt: 'Based on my current tasks, priorities, and deadlines — what should I focus on next?',
    icon: <Zap size={14} />,
  },
  {
    id: 'summarize-day',
    label: 'Summarize my day',
    prompt: 'Give me a summary of my day — what I completed, what\'s remaining, and any items that need attention.',
    icon: <CalendarDays size={14} />,
  },
  {
    id: 'help-plan',
    label: 'Help me plan',
    prompt: 'Help me plan my day. Look at my priorities, deadlines, and energy level to suggest a focused schedule.',
    icon: <ListTodo size={14} />,
  },
  {
    id: 'triage',
    label: 'Triage for me',
    prompt: 'Review my unread notifications and triage queue. Categorize items into: act now, schedule for later, or dismiss.',
    icon: <Sparkles size={14} />,
  },
  {
    id: 'insights',
    label: 'Show insights',
    prompt: 'What patterns do you see in my task completion? Any productivity insights or suggestions?',
    icon: <Brain size={14} />,
  },
];

interface HoustonQuickActionsProps {
  onAction: (prompt: string) => void;
  disabled?: boolean;
  actions?: QuickAction[];
}

export function HoustonQuickActions({
  onAction,
  disabled = false,
  actions = defaultActions,
}: HoustonQuickActionsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.1 }}
      className="space-y-2"
    >
      <h3 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider px-1">
        Quick Actions
      </h3>
      <div className="flex flex-wrap gap-2">
        {actions.map((action, index) => (
          <motion.button
            key={action.id}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, delay: 0.05 * index }}
            onClick={() => onAction(action.prompt)}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full
              border border-[var(--border)] bg-[var(--surface-1)]/60 backdrop-blur-sm
              text-xs font-medium text-[var(--text-secondary)]
              hover:border-blue-400/50 hover:bg-blue-500/10 hover:text-blue-300
              active:scale-95 transition-all duration-150
              disabled:opacity-40 disabled:pointer-events-none
              min-h-[44px]"
            aria-label={action.label}
          >
            <span className="text-[var(--text-tertiary)] group-hover:text-blue-400">
              {action.icon}
            </span>
            {action.label}
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}
