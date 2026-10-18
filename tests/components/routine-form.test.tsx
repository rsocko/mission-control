import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoutineForm } from '@/components/routines/RoutineForm';
import type { Routine } from '@/components/routines/types';

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock('@rsocko/icon-picker/picker', () => ({
  IconPickerButton: ({
    value,
    onChange,
    color,
    onColorChange,
    label,
  }: {
    value: string | null;
    onChange: (value: string) => void;
    color?: string;
    onColorChange?: (value: string) => void;
    label?: string;
  }) => (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        onChange('lucide:activity');
        onColorChange?.('#3b82f6');
      }}
    >
      {value ?? 'No icon'} {color}
    </button>
  ),
}));

const routine: Routine = {
  id: 'routine-1',
  name: 'Morning walk',
  description: 'Before work',
  icon: '🚶',
  iconColor: null,
  cadenceType: 'daily',
  cadenceConfig: {},
  sortOrder: 0,
  isActive: true,
  isArchived: false,
  streak: 2,
  weekCompletions: [],
  weekSkips: [],
  intervalStatus: null,
  weeklyProgress: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('RoutineForm', () => {
  it('updates an existing routine', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    const onSaved = vi.fn();

    render(<RoutineForm routine={routine} onClose={vi.fn()} onSaved={onSaved} />);

    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Evening walk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/routines/routine-1', expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    const request = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      name: 'Evening walk',
      description: 'Before work',
      icon: '🚶',
      cadenceType: 'daily',
      cadenceConfig: {},
    });
    expect(toastSuccess).toHaveBeenCalledWith('Routine updated');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not submit a blank name', () => {
    global.fetch = vi.fn() as typeof fetch;

    render(<RoutineForm routine={routine} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(toastError).toHaveBeenCalledWith('Routine name is required');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses the icon picker and saves the selected icon', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    render(<RoutineForm routine={routine} onClose={vi.fn()} onSaved={vi.fn()} />);

    const iconPicker = screen.getByRole('button', { name: 'Choose routine icon' });
    expect(iconPicker).toHaveTextContent('🚶');

    fireEvent.click(iconPicker);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    const request = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      icon: 'lucide:activity',
      iconColor: '#3b82f6',
    });
  });
});
