'use client';

import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { CheckCircle, Circle, ChevronDown, ChevronUp, Target, Brain, Lightbulb, Rocket, Server, Zap } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { GoalItem } from './types';

interface MobileGoalCardProps {
  item: GoalItem;
  onTap?: (id: string) => void;
}

/** Picks a color scheme based on goal progress or type. */
function getGoalColorScheme(item: GoalItem) {
  const progress = item.progress ?? 0;
  if (progress >= 66) return { text: 'text-emerald-400', bg: 'bg-emerald-500/15', gradient: 'from-emerald-400 to-emerald-500' };
  if (progress >= 33) return { text: 'text-amber-400', bg: 'bg-amber-500/15', gradient: 'from-amber-400 to-amber-500' };
  return { text: 'text-sky-400', bg: 'bg-sky-500/15', gradient: 'from-sky-400 to-sky-500' };
}

/** Picks an icon for the goal based on type or linked project. */
function renderGoalIcon(item: GoalItem, className: string) {
  if (item.goalType === 'brainstorm') return <Brain size={14} className={className} />;
  if (item.goalType === 'idea') return <Lightbulb size={14} className={className} />;
  // For goals, try to match based on project context
  const firstProject = item.linkedProjects[0];
  if (firstProject) {
    const name = firstProject.name.toLowerCase();
    if (name.includes('ios') || name.includes('app') || name.includes('ship')) return <Rocket size={14} className={className} />;
    if (name.includes('server') || name.includes('home') || name.includes('self-host')) return <Server size={14} className={className} />;
    if (name.includes('auto')) return <Zap size={14} className={className} />;
  }
  return <Target size={14} className={className} />;
}

export function MobileGoalCard({ item, onTap }: MobileGoalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const prefersReducedMotion = useReducedMotion() ?? false;
  const colors = getGoalColorScheme(item);
  const progress = item.progress ?? 0;

  // Collect all milestones from linked projects
  const milestones = item.linkedProjects.flatMap(p => 
    (p.milestones ?? []).map(m => ({ ...m, projectName: p.name }))
  );
  const hasMilestones = milestones.length > 0;

  // Compute key results count from milestones
  const keyResultsCount = milestones.length || item.linkedProjects.length;
  const completedMilestones = milestones.filter(m => m.completed).length;

  // Format due date
  const dueLabel = item.dueDate
    ? new Date(item.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <motion.div
      className="rounded-[22px] bg-[var(--surface-1)]/80 backdrop-blur-xl border border-[var(--border-subtle)] p-4"
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
      onClick={() => onTap?.(item.id)}
    >
      {/* Top row: icon, title, progress */}
      <div className="flex items-center gap-3">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-full flex-shrink-0', colors.bg)}>
          {renderGoalIcon(item, colors.text)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-[var(--text-primary)] leading-tight truncate">
            {item.title}
          </p>
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
            {keyResultsCount > 0 && `${keyResultsCount} ${hasMilestones ? 'key results' : 'linked projects'}`}
            {dueLabel && ` · Due ${dueLabel}`}
            {!keyResultsCount && !dueLabel && `${item.linkedProjects.length} projects`}
          </p>
        </div>
        <span className={cn('text-sm font-bold tabular-nums', colors.text)}>
          {progress}%
        </span>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-2 rounded-full bg-[var(--surface-3)]">
        <div
          className={cn('h-2 rounded-full bg-gradient-to-r transition-all duration-500', colors.gradient)}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Expandable milestones/key results */}
      {hasMilestones && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="mt-2 flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors min-h-[44px] w-full justify-center"
            aria-label={expanded ? 'Collapse milestones' : 'Expand milestones'}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>{completedMilestones}/{milestones.length} milestones</span>
          </button>

          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={prefersReducedMotion ? undefined : { height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={prefersReducedMotion ? undefined : { height: 0, opacity: 0 }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="space-y-1.5 pt-1 pl-[52px]">
                  {milestones.map((milestone) => (
                    <div key={milestone.id} className="flex items-center gap-2 text-xs">
                      {milestone.completed ? (
                        <CheckCircle size={10} className="text-emerald-400 flex-shrink-0" />
                      ) : (
                        <Circle size={10} className="text-[var(--text-tertiary)] flex-shrink-0" />
                      )}
                      <span className={cn(
                        milestone.completed
                          ? 'text-[var(--text-tertiary)] line-through'
                          : 'text-[var(--text-secondary)]'
                      )}>
                        {milestone.name}
                      </span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {/* Linked projects (when no milestones, show project links) */}
      {!hasMilestones && item.linkedProjects.length > 0 && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {item.linkedProjects.map((project) => (
            <span
              key={project.id}
              className="inline-flex items-center gap-1.5 text-xs text-[var(--text-tertiary)] bg-[var(--surface-2)] rounded-full px-2 py-0.5"
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: project.color }}
              />
              {project.name}
              {(project.progress !== undefined && project.progress > 0) && (
                <span className={cn('ml-1 font-medium', colors.text)}>{project.progress}%</span>
              )}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}
