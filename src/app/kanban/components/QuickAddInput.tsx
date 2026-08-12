'use client';

import { Plus, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Tooltip } from '@/components/ui/Tooltip';

interface QuickAddInputProps {
  columnId: string;
  isOpen: boolean;
  value: string;
  onChange: (val: string) => void;
  onSubmit: (columnId: string) => void;
  onCancel: () => void;
}

export function QuickAddInput({ columnId, isOpen, value, onChange, onSubmit, onCancel }: QuickAddInputProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="flex items-center gap-1 mt-1"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.15 }}
        >
          <input
            autoFocus
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onSubmit(columnId);
              if (e.key === 'Escape') onCancel();
            }}
            placeholder="Task title..."
            className="flex-1 text-xs px-2 py-1.5 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-blue-500/50"
          />
          <Tooltip content="Add task">
            <button
              onClick={() => onSubmit(columnId)}
              className="p-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              <Plus size={12} />
            </button>
          </Tooltip>
          <Tooltip content="Cancel">
            <button
              onClick={onCancel}
              className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-muted)] transition-colors"
            >
              <X size={12} />
            </button>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
