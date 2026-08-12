'use client';

import { motion } from 'motion/react';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils/cn';
import { useListAnimate } from '@/lib/hooks/useListAnimate';
import { GoalCard } from './GoalCard';
import { GOAL_TYPE_CONFIG, type GoalItem, type GoalType } from './types';

interface GoalSectionProps {
  type: GoalType;
  items: GoalItem[];
  developingId: string | null;
  onDevelop: (id: string) => void;
}

export function GoalSection({ type, items, developingId, onDevelop }: GoalSectionProps) {
  const config = GOAL_TYPE_CONFIG[type];
  const Icon = config.icon;
  const [animateRef] = useListAnimate();

  return (
    <motion.section variants={fadeSlideUp}>
      <div className="flex items-center gap-3 mb-4">
        <div className={cn('w-7 h-7 rounded-full flex items-center justify-center', config.bgColor)}>
          <Icon size={14} className={config.color} />
        </div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{config.label}</h3>
        <span className="text-xs text-[var(--text-tertiary)]">{config.sublabel}</span>
        <span className={cn('ml-auto text-[12px] px-2 py-0.5 rounded-full font-medium', config.badgeColor)}>
          {items.length}
        </span>
      </div>

      <div ref={animateRef} className={cn('grid gap-3', type === 'idea' ? 'grid-cols-1 lg:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2')}>
        {items.map(item => (
          <GoalCard
            key={item.id}
            item={item}
            onDevelop={onDevelop}
            developing={developingId === item.id}
          />
        ))}
      </div>
    </motion.section>
  );
}
