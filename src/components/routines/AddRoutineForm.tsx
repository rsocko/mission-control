'use client';

import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { CADENCE_OPTIONS, type CadenceConfig, type CadenceType } from './types';

interface AddRoutineFormProps {
  onClose: () => void;
  onCreated: () => void;
}

const dayLabels = [
  { day: 1, label: 'M' },
  { day: 2, label: 'T' },
  { day: 3, label: 'W' },
  { day: 4, label: 'T' },
  { day: 5, label: 'F' },
  { day: 6, label: 'S' },
  { day: 0, label: 'S' },
];

export function AddRoutineForm({ onClose, onCreated }: AddRoutineFormProps) {
  const [name, setName] = useState('');
  const [cadenceType, setCadenceType] = useState<CadenceType>('daily');
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 3, 5]);
  const [targetPerWeek, setTargetPerWeek] = useState(3);
  const [minDays, setMinDays] = useState(3);
  const [maxDays, setMaxDays] = useState(4);
  const [submitting, setSubmitting] = useState(false);

  const toggleDay = (day: number) => {
    setSelectedDays((previous) =>
      previous.includes(day) ? previous.filter((value) => value !== day) : [...previous, day],
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('Routine name is required');
      return;
    }

    setSubmitting(true);

    const cadenceConfig: CadenceConfig = {};
    if (cadenceType === 'specific_days') cadenceConfig.days = selectedDays;
    if (cadenceType === 'x_per_week') cadenceConfig.target = targetPerWeek;
    if (cadenceType === 'every_n_days') {
      cadenceConfig.minDays = minDays;
      cadenceConfig.maxDays = maxDays;
    }

    try {
      const response = await fetch('/api/routines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cadenceType, cadenceConfig }),
      });

      if (!response.ok) {
        throw new Error('Failed to create routine');
      }

      toast.success('Routine created!');
      onCreated();
    } catch {
      toast.error('Failed to create routine');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          Add Routine
        </p>
        <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <X size={16} />
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-2 block font-medium text-[var(--text-secondary)]">Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Take vitamins"
            className="w-full rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors duration-[var(--transition-fast)]"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-2 block font-medium text-[var(--text-secondary)]">Cadence type</span>
          <Select value={cadenceType} onValueChange={(value) => setCadenceType(value as CadenceType)}>
            <SelectTrigger className="w-full rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CADENCE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      {cadenceType === 'daily' && (
        <p className="rounded-[var(--radius-md)] bg-[var(--surface-0)] p-3 text-sm text-[var(--text-muted)]">
          Daily routines track every day by default.
        </p>
      )}

      {cadenceType === 'specific_days' && (
        <div>
          <p className="mb-3 text-sm font-medium text-[var(--text-secondary)]">Expected days</p>
          <div className="flex flex-wrap gap-2">
            {dayLabels.map(({ day, label }) => (
              <button
                key={day}
                onClick={() => toggleDay(day)}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] border text-sm font-medium transition-colors duration-[var(--transition-fast)] active:scale-[0.96]',
                  selectedDays.includes(day)
                    ? 'border-[var(--accent-600)] bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
                    : 'border-[var(--border-strong)] bg-[var(--surface-0)] text-[var(--text-secondary)] hover:border-[var(--accent-500)]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {cadenceType === 'x_per_week' && (
        <label className="block max-w-xs text-sm">
          <span className="mb-2 block font-medium text-[var(--text-secondary)]">Target per week</span>
          <input
            type="number"
            min={1}
            max={7}
            value={targetPerWeek}
            onChange={(event) => setTargetPerWeek(Number(event.target.value))}
            className="w-full rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
          />
        </label>
      )}

      {cadenceType === 'every_n_days' && (
        <div className="grid max-w-md gap-4 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-2 block font-medium text-[var(--text-secondary)]">Min interval (days)</span>
            <input
              type="number"
              min={1}
              value={minDays}
              onChange={(event) => setMinDays(Number(event.target.value))}
              className="w-full rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-2 block font-medium text-[var(--text-secondary)]">Max interval (days)</span>
            <input
              type="number"
              min={1}
              value={maxDays}
              onChange={(event) => setMaxDays(Number(event.target.value))}
              className="w-full rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
            />
          </label>
        </div>
      )}

      {(cadenceType === 'weekly' || cadenceType === 'monthly' || cadenceType === 'quarterly') && (
        <p className="rounded-[var(--radius-md)] bg-[var(--surface-0)] p-3 text-sm text-[var(--text-muted)]">
          {cadenceType === 'weekly' && 'Complete once per week. No specific day required.'}
          {cadenceType === 'monthly' && 'Complete once per month. Tracked with a progress bar.'}
          {cadenceType === 'quarterly' && 'Complete once per quarter. Long-interval tracking.'}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose} size="sm">
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={submitting} size="sm">
          {submitting ? (
            <Loader2 size={14} className="mr-1 animate-spin" />
          ) : (
            <Plus size={14} className="mr-1" />
          )}
          Add routine
        </Button>
      </div>
    </div>
  );
}
