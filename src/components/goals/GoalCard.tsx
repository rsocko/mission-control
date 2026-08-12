'use client';

import { motion } from 'motion/react';
import { ChartNetwork, Loader2, Sparkles } from 'lucide-react';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils/cn';
import { GOAL_TYPE_CONFIG, getRelativeTime, type GoalItem } from './types';

interface GoalCardProps {
  item: GoalItem;
  onDevelop: (id: string) => void;
  developing: boolean;
}

export function GoalCard({ item, onDevelop, developing }: GoalCardProps) {
  const config = GOAL_TYPE_CONFIG[item.goalType];
  const Icon = config.icon;
  const age = getRelativeTime(item.createdAt);

  return (
    <motion.div
      variants={fadeSlideUp}
      className={cn(
        'bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-lg)] p-4 cursor-pointer',
        'hover:border-[var(--border-strong)] transition-colors duration-150'
      )}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          {item.goalType !== 'goal' && (
            <Icon size={13} className={cn(config.color, 'mt-0.5 flex-shrink-0')} />
          )}
          <h4 className="text-sm font-medium text-[var(--text-primary)] leading-snug">{item.title}</h4>
        </div>
        <button
          onClick={event => {
            event.stopPropagation();
            onDevelop(item.id);
          }}
          disabled={developing}
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-[12px] font-medium rounded-[var(--radius-sm)] ml-2 flex-shrink-0',
            'border border-[var(--border)] text-[var(--accent-400)]',
            'hover:bg-[var(--accent-900)]/30 hover:border-[var(--accent-600)]/50 transition-colors duration-150',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {developing ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
          Develop
        </button>
      </div>

      {item.description && (
        <p className="text-xs text-[var(--text-tertiary)] mb-3 line-clamp-2 leading-relaxed">
          {item.description}
        </p>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 flex-wrap">
          {item.tags
            .filter(tag => !['goal', 'idea', 'brainstorm'].includes(tag.slug))
            .slice(0, 3)
            .map(tag => (
              <span
                key={tag.id}
                className="text-[12px] px-2 py-0.5 rounded-full font-medium bg-[var(--surface-2)] text-[var(--text-secondary)]"
              >
                #{tag.slug}
              </span>
            ))}
        </div>
        <span className="text-[12px] text-[var(--text-tertiary)] flex-shrink-0">{age}</span>
      </div>

      {item.linkedProjects.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
          <div className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]">
            <ChartNetwork size={10} />
            <span>{item.linkedProjects.map(project => project.name).join(', ')}</span>
          </div>
        </div>
      )}
    </motion.div>
  );
}
