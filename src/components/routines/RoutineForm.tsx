'use client';

import { useState } from 'react';
import { Loader2, Plus, Save, X } from 'lucide-react';
import { IconPickerButton } from '@rsocko/icon-picker/picker';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { CADENCE_OPTIONS, type CadenceConfig, type CadenceType, type Routine } from './types';

interface RoutineFormProps {
  routine?: Routine;
  onClose: () => void;
  onSaved: () => void;
}

const dayLabels = [
  { day: 1, label: 'M', name: 'Monday' },
  { day: 2, label: 'T', name: 'Tuesday' },
  { day: 3, label: 'W', name: 'Wednesday' },
  { day: 4, label: 'T', name: 'Thursday' },
  { day: 5, label: 'F', name: 'Friday' },
  { day: 6, label: 'S', name: 'Saturday' },
  { day: 0, label: 'S', name: 'Sunday' },
];

export function RoutineForm({ routine, onClose, onSaved }: RoutineFormProps) {
  const editing = Boolean(routine);
  const [name, setName] = useState(routine?.name ?? '');
  const [description, setDescription] = useState(routine?.description ?? '');
  const [icon, setIcon] = useState(routine?.icon ?? '');
  const [iconColor, setIconColor] = useState(routine?.iconColor ?? '');
  const [cadenceType, setCadenceType] = useState<CadenceType>(routine?.cadenceType ?? 'daily');
  const [selectedDays, setSelectedDays] = useState<number[]>(routine?.cadenceConfig.days ?? [1, 3, 5]);
  const [targetPerWeek, setTargetPerWeek] = useState(routine?.cadenceConfig.target ?? 3);
  const [minDays, setMinDays] = useState(routine?.cadenceConfig.minDays ?? 3);
  const [maxDays, setMaxDays] = useState(routine?.cadenceConfig.maxDays ?? 4);
  const [submitting, setSubmitting] = useState(false);

  const toggleDay = (day: number) => {
    setSelectedDays((previous) =>
      previous.includes(day) ? previous.filter((value) => value !== day) : [...previous, day],
    );
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Routine name is required');
      return;
    }
    if (cadenceType === 'specific_days' && selectedDays.length === 0) {
      toast.error('Select at least one expected day');
      return;
    }
    if (cadenceType === 'x_per_week' && (!Number.isInteger(targetPerWeek) || targetPerWeek < 1 || targetPerWeek > 7)) {
      toast.error('Weekly target must be between 1 and 7');
      return;
    }
    if (cadenceType === 'every_n_days' && (!Number.isInteger(minDays) || !Number.isInteger(maxDays) || minDays < 1 || maxDays < minDays)) {
      toast.error('Maximum interval must be at least the minimum interval');
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
      const response = await fetch(editing ? `/api/routines/${routine?.id}` : '/api/routines', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          description: description.trim() || null,
          icon: icon.trim() || null,
          iconColor: iconColor.trim() || null,
          cadenceType,
          cadenceConfig,
        }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || `Failed to ${editing ? 'update' : 'create'} routine`);
      }

      toast.success(editing ? 'Routine updated' : 'Routine created');
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to ${editing ? 'update' : 'create'} routine`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-routine-editor className="space-y-4 rounded-[var(--radius-lg)] border border-[var(--accent-700)]/50 bg-[var(--surface-1)] p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          {editing ? `Edit ${routine?.name}` : 'Add Routine'}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${editing ? 'routine editor' : 'new routine form'}`}
          className="rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_7rem]">
        <label className="block text-sm">
          <span className="mb-2 block font-medium text-[var(--text-secondary)]">Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Take vitamins"
            autoFocus
            className="w-full rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors duration-[var(--transition-fast)] focus:border-[var(--accent-500)]"
          />
        </label>
        <div className="block text-sm">
          <span className="mb-2 block font-medium text-[var(--text-secondary)]">Icon</span>
          <IconPickerButton
            value={icon || null}
            onChange={setIcon}
            size="md"
            color={iconColor || undefined}
            onColorChange={setIconColor}
            label="Choose routine icon"
          />
        </div>
      </div>

      <label className="block text-sm">
        <span className="mb-2 block font-medium text-[var(--text-secondary)]">Description</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Optional notes about this routine"
          rows={2}
          className="w-full resize-y rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors duration-[var(--transition-fast)] focus:border-[var(--accent-500)]"
        />
      </label>

      <div className="grid gap-4 md:grid-cols-2">
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
            {dayLabels.map(({ day, label, name: dayName }) => (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(day)}
                aria-label={dayName}
                aria-pressed={selectedDays.includes(day)}
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
        <Button type="button" variant="ghost" onClick={onClose} size="sm">
          Cancel
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={submitting} size="sm">
          {submitting ? (
            <Loader2 size={14} className="mr-1 animate-spin" />
          ) : editing ? (
            <Save size={14} className="mr-1" />
          ) : (
            <Plus size={14} className="mr-1" />
          )}
          {editing ? 'Save changes' : 'Add routine'}
        </Button>
      </div>
    </div>
  );
}
