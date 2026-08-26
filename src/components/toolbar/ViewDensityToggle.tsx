'use client';

import { useState, useEffect } from 'react';
import { ListChevronsUpDown, ListChevronsDownUp } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

const STORAGE_KEY = 'mission-control:view-density';

export type ViewDensity = 'compact' | 'comfortable';

interface ViewDensityToggleProps {
  value?: ViewDensity;
  onChange?: (density: ViewDensity) => void;
}

export function ViewDensityToggle({ value, onChange }: ViewDensityToggleProps = {}) {
  const [internalDensity, setInternalDensity] = useState<ViewDensity>('comfortable');
  const density = value ?? internalDensity;

  useEffect(() => {
    if (value !== undefined) return;
    const stored = localStorage.getItem(STORAGE_KEY) as ViewDensity | null;
    if (stored) setInternalDensity(stored);
  }, [value]);

  const toggle = () => {
    const next: ViewDensity = density === 'comfortable' ? 'compact' : 'comfortable';
    if (value === undefined) {
      setInternalDensity(next);
      localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(new CustomEvent('mission-control:density-change', { detail: next }));
    }
    onChange?.(next);
  };

  const tooltipText = density === 'comfortable' ? 'Switch to compact view' : 'Switch to expanded view';

  return (
    <Tooltip content={tooltipText} placement="bottom">
      <button
        onClick={toggle}
        aria-pressed={density === 'compact'}
        aria-label={tooltipText}
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-md)] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-0)]"
      >
        {density === 'comfortable' ? <ListChevronsDownUp size={13} /> : <ListChevronsUpDown size={13} />}
      </button>
    </Tooltip>
  );
}
