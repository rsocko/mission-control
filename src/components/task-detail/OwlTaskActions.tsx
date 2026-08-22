'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, Moon, Save } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { postOwlTaskAction, type OwlTaskActionUpdate } from './task-detail-api';
import type { TaskDetailMetadata } from './task-detail-types';

const ACTION_TYPES = [
  ['pay', 'Pay'],
  ['respond', 'Respond'],
  ['sign', 'Sign'],
  ['schedule', 'Schedule'],
  ['file', 'File'],
  ['review', 'Review'],
] as const;

const URGENCY_VALUES = [
  ['critical', 'Critical'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
] as const;

export interface OwlTaskActionsProps {
  taskId: string;
  metadata: TaskDetailMetadata;
  snoozedUntil?: string | null;
  onTaskUpdate: (update: OwlTaskActionUpdate) => void;
}

function toLocalDateTimeInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function tomorrowMorning(now: Date): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

export function OwlTaskActions({
  taskId,
  metadata,
  snoozedUntil,
  onTaskUpdate,
}: OwlTaskActionsProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [customUntil, setCustomUntil] = useState(() => toLocalDateTimeInput(tomorrowMorning(new Date())));
  const [actionType, setActionType] = useState(metadata.actionType || 'review');
  const [urgency, setUrgency] = useState(metadata.urgency || 'medium');
  const [amount, setAmount] = useState(
    typeof metadata.amount === 'number' ? String(metadata.amount) : '',
  );

  const snoozeLabel = useMemo(() => {
    if (!snoozedUntil) return null;
    const parsed = new Date(snoozedUntil);
    return Number.isNaN(parsed.getTime()) ? snoozedUntil : parsed.toLocaleString();
  }, [snoozedUntil]);

  async function submit(
    key: string,
    payload: Record<string, unknown>,
    successMessage: string,
  ) {
    setBusyAction(key);
    setMessage(null);
    try {
      const result = await postOwlTaskAction(taskId, payload);
      if (!result.ok || !result.task) {
        setMessage({ kind: 'error', text: result.error || 'OWL did not accept the update.' });
        return;
      }
      onTaskUpdate(result.task);
      setMessage({ kind: 'success', text: successMessage });
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach Mission Control. Try again.' });
    } finally {
      setBusyAction(null);
    }
  }

  function snooze(until: Date, label: string) {
    void submit('snooze', { action: 'snooze', until: until.toISOString() }, `Snoozed in OWL until ${label}.`);
  }

  const inputClass = 'min-h-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] px-2.5 text-sm text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
  const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:cursor-wait disabled:opacity-60';

  return (
    <div className="w-full space-y-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)]/55 p-3">
      <div>
        <p className="text-xs font-semibold text-[var(--text-primary)]">OWL action outcome</p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          These actions update OWL and its Paperless-backed action queue.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => {
            const now = new Date();
            snooze(new Date(now.getTime() + 4 * 60 * 60 * 1000), 'four hours from now');
          }}
          className={buttonClass}
        >
          {busyAction === 'snooze' ? <Loader2 size={13} className="animate-spin" /> : <Moon size={13} />}
          Snooze 4 hours
        </button>
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => snooze(tomorrowMorning(new Date()), 'tomorrow morning')}
          className={buttonClass}
        >
          Tomorrow morning
        </button>
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => {
            const nextWeek = tomorrowMorning(new Date());
            nextWeek.setDate(nextWeek.getDate() + 6);
            snooze(nextWeek, 'next week');
          }}
          className={buttonClass}
        >
          Next week
        </button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--text-muted)]">
          Custom source-side snooze
          <input
            type="datetime-local"
            value={customUntil}
            min={toLocalDateTimeInput(new Date())}
            onChange={(event) => setCustomUntil(event.target.value)}
            className={inputClass}
          />
        </label>
        <button
          type="button"
          disabled={busyAction !== null || !customUntil}
          onClick={() => {
            const until = new Date(customUntil);
            if (Number.isNaN(until.getTime()) || until <= new Date()) {
              setMessage({ kind: 'error', text: 'Choose a future snooze time.' });
              return;
            }
            snooze(until, until.toLocaleString());
          }}
          className={buttonClass}
        >
          Snooze in OWL
        </button>
      </div>
      {snoozeLabel && (
        <p className="text-xs text-[var(--text-muted)]">Currently snoozed until {snoozeLabel}.</p>
      )}

      <button
        type="button"
        disabled={busyAction !== null}
        onClick={() => void submit(
          'not-an-action',
          { action: 'not_an_action' },
          'Marked as no action needed in OWL.',
        )}
        className={`${buttonClass} border-amber-500/25 text-amber-300`}
      >
        {busyAction === 'not-an-action'
          ? <Loader2 size={13} className="animate-spin" />
          : <AlertTriangle size={13} />}
        No action needed
      </button>

      <details className="rounded-lg border border-[var(--border-subtle)]">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
          Correct extraction
        </summary>
        <div className="grid gap-3 border-t border-[var(--border-subtle)] p-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`owl-action-type-${taskId}`} className="text-xs text-[var(--text-muted)]">
              Action type
            </label>
            <Select
              value={actionType}
              onValueChange={setActionType}
            >
              <SelectTrigger
                id={`owl-action-type-${taskId}`}
                aria-label="OWL action type"
                className={inputClass}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTION_TYPES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void submit(
                'action-type',
                { action: 'correct', field: 'action_type', value: actionType },
                'Action type correction sent to OWL.',
              )}
              className={buttonClass}
            >
              {busyAction === 'action-type' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save type
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={`owl-urgency-${taskId}`} className="text-xs text-[var(--text-muted)]">
              Urgency
            </label>
            <Select
              value={urgency}
              onValueChange={setUrgency}
            >
              <SelectTrigger
                id={`owl-urgency-${taskId}`}
                aria-label="OWL urgency"
                className={inputClass}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {URGENCY_VALUES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void submit(
                'urgency',
                { action: 'correct', field: 'urgency', value: urgency },
                'Urgency correction sent to OWL.',
              )}
              className={buttonClass}
            >
              {busyAction === 'urgency' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save urgency
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={`owl-amount-${taskId}`} className="text-xs text-[var(--text-muted)]">
              Amount
            </label>
            <input
              id={`owl-amount-${taskId}`}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className={inputClass}
            />
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => {
                const correctedAmount = amount.trim() === '' ? null : Number(amount);
                if (correctedAmount !== null && (!Number.isFinite(correctedAmount) || correctedAmount < 0)) {
                  setMessage({ kind: 'error', text: 'Amount must be zero or greater.' });
                  return;
                }
                void submit(
                  'amount',
                  { action: 'correct', field: 'amount', value: correctedAmount },
                  'Amount correction sent to OWL.',
                );
              }}
              className={buttonClass}
            >
              {busyAction === 'amount' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save amount
            </button>
          </div>
        </div>
      </details>

      <div aria-live="polite" aria-atomic="true" className="min-h-5">
        {message && (
          <p className={`flex items-center gap-1.5 text-xs ${
            message.kind === 'success' ? 'text-[var(--success)]' : 'text-[var(--danger)]'
          }`}>
            {message.kind === 'success' && <Check size={13} aria-hidden="true" />}
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
