'use client';

import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sparkles, X, AlertCircle, ChevronDown } from 'lucide-react';
import { MICRO_STATUS_CONFIG } from '@/types';
import type { MicroStatus } from '@/types';
import { MicroStatusIcon } from '@/components/task-list/MicroStatusIcon';
import { useClickOutside } from '@/lib/hooks/useClickOutside';

export interface MicroStatusPickerProps {
  /** Task ID for API calls. */
  taskId: string;
  /** Current micro-status value (null = not set). */
  value: string | null;
  /** Called after a status change (pass new value or null to clear). */
  onChange: (microStatus: string | null) => void;
  /** Whether editing is allowed. */
  canEdit?: boolean;
}

/**
 * Micro-status picker with AI suggestion support.
 * Shows current status as a pill, opens a dropdown with all options.
 */
export function MicroStatusPicker({
  taskId,
  value,
  onChange,
  canEdit = true,
}: MicroStatusPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<{ status: string; reason: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => setIsOpen(false), isOpen);

  const handleChange = useCallback((status: string | null) => {
    onChange(status);
    setIsOpen(false);
    setSuggestion(null);
  }, [onChange]);

  const fetchSuggestion = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/suggest-micro-status');
      if (!res.ok) return;
      const data = await res.json();
      const match = data.suggestions?.find((s: { taskId: string }) => s.taskId === taskId);
      if (match) {
        setSuggestion({ status: match.suggestedStatus, reason: match.reason });
      }
    } catch { /* ignore */ }
  }, [taskId]);

  const currentConfig = value ? MICRO_STATUS_CONFIG[value as MicroStatus] : null;

  return (
    <div className="relative" ref={ref}>
      {/* Current status display / trigger */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => canEdit && setIsOpen(!isOpen)}
          disabled={!canEdit}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs transition-colors duration-75 ${
            canEdit ? 'hover:bg-[var(--surface-2)]' : 'opacity-60 cursor-not-allowed'
          }`}
        >
          {currentConfig ? (
            <>
              <MicroStatusIcon status={value as MicroStatus} size={13} />
              <span style={{ color: currentConfig.color }}>{currentConfig.label}</span>
            </>
          ) : (
            <>
              <AlertCircle size={11} className="text-[var(--text-muted)]" />
              <span className="text-[var(--text-muted)]">Status reason</span>
            </>
          )}
          <ChevronDown size={10} className="text-[var(--text-muted)]" />
        </button>

        {/* AI suggestion button */}
        {canEdit && !suggestion && (
          <button
            onClick={fetchSuggestion}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
            title="Get AI suggestion"
          >
            <Sparkles size={11} />
          </button>
        )}
      </div>

      {/* AI suggestion banner */}
      {suggestion && MICRO_STATUS_CONFIG[suggestion.status as MicroStatus] && (
        <div className="mt-1.5 flex items-start gap-1.5 p-1.5 rounded-md bg-[var(--accent)]/10 border border-[var(--accent)]/20">
          <Sparkles size={10} className="text-[var(--accent)] mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <button
              onClick={() => handleChange(suggestion.status)}
              className="text-xs text-[var(--accent)] hover:underline font-medium"
            >
              <MicroStatusIcon status={suggestion.status as MicroStatus} size={12} className="mr-1 inline" />
              {MICRO_STATUS_CONFIG[suggestion.status as MicroStatus].label}
            </button>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-tight">{suggestion.reason}</p>
          </div>
          <button
            onClick={() => setSuggestion(null)}
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] flex-shrink-0"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* Picker dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="absolute left-0 top-full mt-1 w-64 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl z-20 overflow-hidden"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
          >
            <div className="px-3 pt-2.5 pb-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              Why isn&apos;t this moving?
            </div>
            <div className="max-h-60 overflow-y-auto">
              {/* Clear option */}
              {value && (
                <button
                  onClick={() => handleChange(null)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-0)] transition-colors text-xs text-[var(--text-muted)]"
                >
                  <span className="w-4 text-center"><X size={12} /></span>
                  <span>Clear status reason</span>
                </button>
              )}
              {(Object.entries(MICRO_STATUS_CONFIG) as [MicroStatus, (typeof MICRO_STATUS_CONFIG)[MicroStatus]][]).map(([key, config]) => (
                <button
                  key={key}
                  onClick={() => handleChange(key)}
                  className={`w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-0)] transition-colors ${
                    value === key ? 'bg-[var(--surface-0)]' : ''
                  }`}
                >
                  <MicroStatusIcon status={key} size={14} className="mt-px" style={{ color: config.color }} />
                  <div className="min-w-0 flex-1">
                    <span className="block text-xs font-medium" style={{ color: config.color }}>{config.label}</span>
                    <span className="block text-xs text-[var(--text-muted)] leading-tight">{config.description}</span>
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
