'use client';

import { ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CollapsibleSectionProps {
  /** Section title shown in the header */
  title: string;
  /** Icon rendered before the title */
  icon?: ReactNode;
  /** Whether the section is currently collapsed */
  collapsed: boolean;
  /** Toggle callback */
  onToggle: () => void;
  /** Optional content rendered at the right end of the header */
  headerActions?: ReactNode;
  /** Content to render when expanded */
  children: ReactNode;
  /** Additional className on the outer wrapper */
  className?: string;
}

export function CollapsibleSection({
  title,
  icon,
  collapsed,
  onToggle,
  headerActions,
  children,
  className,
}: CollapsibleSectionProps) {
  return (
    <div className={cn('mb-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] overflow-hidden', className)}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-[var(--surface-2)] transition-colors duration-75 select-none"
        aria-expanded={!collapsed}
      >
        <ChevronRight
          size={14}
          className={cn(
            'text-[var(--text-secondary)] transition-transform duration-150 flex-shrink-0',
            !collapsed && 'rotate-90',
          )}
        />
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
          {title}
        </span>
        {headerActions && (
          <span className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {headerActions}
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
