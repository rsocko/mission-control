'use client';

import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { staggerContainer } from '@/lib/motion';
import { EmptyState } from './EmptyState';
import { GoalSection } from './GoalSection';
import type { FilterType, GoalItem, GoalType } from './types';

const GOAL_TYPES: GoalType[] = ['goal', 'idea', 'brainstorm'];

interface GoalsContentProps {
  loading: boolean;
  items: GoalItem[];
  filter: FilterType;
  grouped: Partial<Record<GoalType, GoalItem[]>>;
  developingId: string | null;
  onDevelop: (id: string) => void;
}

export function GoalsContent({
  loading,
  items,
  filter,
  grouped,
  developingId,
  onDevelop,
}: GoalsContentProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  if (items.length === 0) {
    return <EmptyState filter={filter} />;
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-8">
      {GOAL_TYPES.map(type => {
        const typeItems = grouped[type];
        if (!typeItems || typeItems.length === 0) return null;
        return (
          <GoalSection
            key={type}
            type={type}
            items={typeItems}
            developingId={developingId}
            onDevelop={onDevelop}
          />
        );
      })}
    </motion.div>
  );
}
