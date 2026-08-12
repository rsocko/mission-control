'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, Clock, Layers, TrendingUp, X, ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';

interface Suggestion {
  id: string;
  type: 'overdue' | 'triage' | 'streak' | 'deadline';
  title: string;
  description: string;
  icon: ReactNode;
  action: string;
  actionPrompt: string;
  urgency: 'high' | 'medium' | 'low';
}

interface SuggestionData {
  overdue: number;
  triagePending: number;
  upcomingDeadlines: number;
  completionStreak: number;
}

function buildSuggestions(data: SuggestionData): Suggestion[] {
  const suggestions: Suggestion[] = [];

  if (data.overdue > 0) {
    suggestions.push({
      id: 'overdue',
      type: 'overdue',
      title: `${data.overdue} overdue ${data.overdue === 1 ? 'task' : 'tasks'}`,
      description: 'These items have passed their due date. Want me to help reschedule or prioritize them?',
      icon: <AlertTriangle size={16} className="text-red-400" />,
      action: 'Review overdue',
      actionPrompt: 'Show me my overdue tasks and help me decide what to do with each one — reschedule, complete, or drop.',
      urgency: 'high',
    });
  }

  if (data.triagePending > 5) {
    suggestions.push({
      id: 'triage',
      type: 'triage',
      title: `${data.triagePending} items need triage`,
      description: 'Your triage queue is building up. I can help categorize and route them quickly.',
      icon: <Layers size={16} className="text-amber-400" />,
      action: 'Start triage',
      actionPrompt: 'Help me triage my pending items. Categorize them and suggest actions for each.',
      urgency: data.triagePending > 15 ? 'high' : 'medium',
    });
  }

  if (data.upcomingDeadlines > 0) {
    suggestions.push({
      id: 'deadlines',
      type: 'deadline',
      title: `${data.upcomingDeadlines} upcoming ${data.upcomingDeadlines === 1 ? 'deadline' : 'deadlines'}`,
      description: 'Tasks due this week that may need your attention.',
      icon: <Clock size={16} className="text-blue-400" />,
      action: 'Plan ahead',
      actionPrompt: 'What tasks do I have due this week? Help me create a plan to get them done on time.',
      urgency: 'medium',
    });
  }

  if (data.completionStreak >= 3) {
    suggestions.push({
      id: 'streak',
      type: 'streak',
      title: `${data.completionStreak}-day completion streak!`,
      description: 'You\'re on a roll. Keep the momentum going.',
      icon: <TrendingUp size={16} className="text-green-400" />,
      action: 'Keep going',
      actionPrompt: 'I\'m on a streak! What\'s the next highest-impact task I can complete quickly?',
      urgency: 'low',
    });
  }

  return suggestions;
}

interface HoustonSuggestionsProps {
  onAction: (prompt: string) => void;
  disabled?: boolean;
}

export function HoustonSuggestions({ onAction, disabled = false }: HoustonSuggestionsProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchContext() {
      try {
        const [tasksRes, triageRes] = await Promise.allSettled([
          fetch('/api/tasks?openOnly=true&countsOnly=true'),
          fetch('/api/triage?status=pending&limit=0'),
        ]);

        let overdue = 0;
        let upcomingDeadlines = 0;
        if (tasksRes.status === 'fulfilled' && tasksRes.value.ok) {
          const data = await tasksRes.value.json();
          overdue = data?.stats?.overdue ?? 0;
          upcomingDeadlines = data?.stats?.dueThisWeek ?? 0;
        }

        let triagePending = 0;
        if (triageRes.status === 'fulfilled' && triageRes.value.ok) {
          const data = await triageRes.value.json();
          triagePending = data?.stats?.pending ?? data?.totalFiltered ?? 0;
        }

        const built = buildSuggestions({
          overdue,
          triagePending,
          upcomingDeadlines,
          completionStreak: 0, // TODO: wire to real streak data
        });

        setSuggestions(built);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }

    void fetchContext();
  }, []);

  const visibleSuggestions = suggestions.filter(s => !dismissed.has(s.id));

  if (loading) {
    return (
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider px-1">
          Suggestions
        </h3>
        <div className="space-y-2">
          {[1, 2].map(i => (
            <div key={i} className="h-20 rounded-xl bg-[var(--surface-2)] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (visibleSuggestions.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.15 }}
      className="space-y-2"
    >
      <h3 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider px-1">
        Suggestions
      </h3>
      <div className="space-y-2">
        <AnimatePresence mode="popLayout">
          {visibleSuggestions.map((suggestion) => (
            <motion.div
              key={suggestion.id}
              layout
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, x: -20 }}
              transition={{ duration: 0.2 }}
              className={`relative rounded-xl border p-3.5 backdrop-blur-sm ${
                suggestion.urgency === 'high'
                  ? 'border-red-500/30 bg-red-500/5'
                  : suggestion.urgency === 'medium'
                  ? 'border-amber-500/20 bg-amber-500/5'
                  : 'border-[var(--border)] bg-[var(--surface-1)]/60'
              }`}
            >
              {/* Dismiss button */}
              <button
                onClick={() => setDismissed(prev => new Set([...prev, suggestion.id]))}
                className="absolute top-2 right-2 p-3 -m-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                aria-label="Dismiss suggestion"
              >
                <X size={12} />
              </button>

              <div className="flex items-start gap-3 pr-6">
                <div className="flex-shrink-0 mt-0.5">
                  {suggestion.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    {suggestion.title}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">
                    {suggestion.description}
                  </p>
                  <button
                    onClick={() => onAction(suggestion.actionPrompt)}
                    disabled={disabled}
                    className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-40 min-h-[44px] -my-2"
                  >
                    {suggestion.action}
                    <ArrowRight size={12} />
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
