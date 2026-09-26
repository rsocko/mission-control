import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast as sonner, type ToastT } from 'sonner';
import { toast } from '@/lib/toast';
import {
  DEFAULT_TOAST_PREFERENCES, getToastPreferences, setToastPreferences,
  TOAST_PREFERENCES_KEY, useToastPreferences,
} from '@/lib/toast-preferences';
import { ToastSettingsCard } from '@/components/settings/ToastSettingsCard';

let testTime = Date.now();

function active(): ToastT[] {
  return sonner.getToasts().filter((entry): entry is ToastT => !('dismiss' in entry));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(testTime += 86_400_000);
  localStorage.clear();
  sonner.dismiss();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('toast delivery policy', () => {
  it('uses brief confirmations and longer errors and actions', () => {
    toast.success('Saved');
    toast.error('Save failed');
    toast.warning('Partial save');
    toast('Moved', { action: { label: 'Undo', onClick: vi.fn() } });
    expect(active().map((entry) => entry.duration)).toEqual([3000, 8000, 8000, 8000]);
  });

  it('preserves explicit deadlines, IDs, and callbacks', () => {
    const onDismiss = vi.fn();
    toast.success('Undo a move', { id: 'undo-deadline', duration: 5000, onDismiss });
    expect(active()[0]).toMatchObject({ id: 'undo-deadline', duration: 5000, onDismiss });
  });

  it('groups repeated plain messages without extending their lifetime', () => {
    const first = toast.info('Synchronized');
    vi.advanceTimersByTime(2000);
    expect(toast.info('Synchronized')).toBe(first);
    expect(active()).toHaveLength(1);
    vi.advanceTimersByTime(1001);
    expect(toast.info('Synchronized')).not.toBe(first);
  });

  it('allows a repeated message after dismissal and does not group distinct actions', () => {
    const first = toast.success('Dismiss me');
    active()[0].onDismiss?.(active()[0]);
    sonner.dismiss(first);
    expect(toast.success('Dismiss me')).not.toBe(first);
    toast('Moved task', { action: { label: 'Undo', onClick: vi.fn() } });
    toast('Moved task', { action: { label: 'Undo', onClick: vi.fn() } });
    expect(active().filter((entry) => entry.title === 'Moved task')).toHaveLength(2);
  });

  it.each(['errors-only', 'mute'] as const)('protects important messages during %s', (mode) => {
    setToastPreferences(mode === 'mute'
      ? { mutedUntil: Date.now() + 60_000 }
      : { mode });
    toast.success('Routine success');
    toast.info('Routine info');
    toast.message('Routine message');
    toast('Routine plain');
    toast.error('Error');
    toast.warning('Warning');
    toast.loading('Progress');
    toast.success('Action', { action: { label: 'Undo', onClick: vi.fn() } });
    toast.info('Persistent', { duration: Infinity });
    toast.info('Required', { dismissible: false });
    expect(active().map((entry) => entry.title)).toEqual([
      'Error', 'Warning', 'Progress', 'Action', 'Persistent', 'Required',
    ]);
  });

  it('ends a loading toast when its routine success is muted, but shows a failure', () => {
    setToastPreferences({ mode: 'errors-only' });
    const id = toast.loading('Working');
    toast.success('Finished', { id });
    expect(active()).toHaveLength(0);
    const failedId = toast.loading('Working again');
    toast.error('Failed', { id: failedId });
    expect(active()).toHaveLength(1);
    expect(active()[0]).toMatchObject({ type: 'error', title: 'Failed', id: failedId });
  });

  it('expires temporary mute without replaying suppressed notifications', () => {
    setToastPreferences({ mutedUntil: Date.now() + 1000 });
    toast.success('Before expiry');
    vi.advanceTimersByTime(1000);
    toast.success('After expiry');
    expect(active().map((entry) => entry.title)).toEqual(['After expiry']);
  });
});

describe('toast preferences', () => {
  it('defaults bottom-left and persists independent changes', () => {
    expect(getToastPreferences()).toEqual(DEFAULT_TOAST_PREFERENCES);
    setToastPreferences({ desktopPosition: 'top-right' });
    setToastPreferences({ mode: 'errors-only' });
    expect(getToastPreferences()).toEqual({ desktopPosition: 'top-right', mode: 'errors-only', mutedUntil: 0 });
  });

  it('reports corrupted preferences and recovers with safe defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(TOAST_PREFERENCES_KEY, '{"desktopPosition":"invalid"}');
    expect(getToastPreferences()).toEqual(DEFAULT_TOAST_PREFERENCES);
    expect(warn).toHaveBeenCalled();
  });

  it('reacts to same-tab changes, cross-tab updates, clearing storage, and expiry', () => {
    function Preferences() {
      const { preferences, muted } = useToastPreferences();
      return <output>{`${preferences.desktopPosition}:${preferences.mode}:${muted}`}</output>;
    }
    render(<Preferences />);
    act(() => setToastPreferences({ mutedUntil: Date.now() + 1000 }));
    expect(screen.getByRole('status')).toHaveTextContent('bottom-left:all:true');
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('status')).toHaveTextContent('bottom-left:all:false');
    act(() => {
      localStorage.setItem(TOAST_PREFERENCES_KEY, JSON.stringify({ ...DEFAULT_TOAST_PREFERENCES, desktopPosition: 'top-right' }));
      window.dispatchEvent(new StorageEvent('storage', { key: TOAST_PREFERENCES_KEY }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('top-right:all:false');
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('bottom-left:all:false');
  });

  it('offers mute and unmute without changing errors-only mode', () => {
    setToastPreferences({ mode: 'errors-only' });
    render(<ToastSettingsCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute for 15 minutes' }));
    expect(getToastPreferences().mutedUntil).toBe(Date.now() + 15 * 60_000);
    expect(screen.getByRole('status')).toHaveTextContent('Routine toasts muted until');
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    expect(getToastPreferences()).toMatchObject({ mode: 'errors-only', mutedUntil: 0 });
  });

  it('shows an inline error if preferences cannot be saved', () => {
    render(<ToastSettingsCard />);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    fireEvent.click(screen.getByRole('button', { name: 'Mute for 1 hour' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save toast preferences');
  });
});
