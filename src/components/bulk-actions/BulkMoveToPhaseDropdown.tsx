'use client';

import { useEffect, useRef, useState } from 'react';
import { Layers3 } from 'lucide-react';

interface BulkMoveToPhaseDropdownProps {
  phases: Array<{ id: string; name: string }>;
  onMoveToPhase: (phaseId: string | null) => Promise<void>;
}

export function BulkMoveToPhaseDropdown({ phases, onMoveToPhase }: BulkMoveToPhaseDropdownProps) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function handleSelect(phaseId: string | null) {
    setMoving(true);
    setOpen(false);
    onMoveToPhase(phaseId).finally(() => setMoving(false));
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="text-xs px-2 py-1 bg-purple-900/30 text-purple-300 border border-purple-800/40 rounded-[var(--radius-sm)] hover:bg-purple-900/50 transition-colors duration-100"
      >
        {moving ? 'Moving…' : <><Layers3 size={12} className="inline mr-1" />Phase</>}
      </button>
      {open && (
        <div role="listbox" aria-label="Move to phase" className="absolute top-full left-0 mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] shadow-lg py-1 min-w-44 max-h-60 overflow-y-auto">
          <button
            onClick={() => handleSelect(null)}
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
          >
            Unassigned (remove from phase)
          </button>
          {phases.map((p) => (
            <button
              key={p.id}
              onClick={() => handleSelect(p.id)}
              className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-75"
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
