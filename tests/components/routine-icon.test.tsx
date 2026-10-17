import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RoutineIcon } from '@/components/routines/RoutineIcon';

vi.mock('@rsocko/icon-picker/renderer', () => ({
  IconRenderer: ({
    value,
    color,
    fallback,
  }: {
    value: string | null;
    color?: string;
    fallback: React.ReactNode;
  }) => value
    ? <span data-testid="rendered-routine-icon" data-value={value} data-color={color} />
    : fallback,
}));

describe('RoutineIcon', () => {
  it('renders provider icons through the shared renderer with their selected color', () => {
    render(
      <RoutineIcon
        routine={{ icon: 'lucide:alarm-clock', iconColor: '#3b82f6' }}
      />,
    );

    const icon = screen.getByTestId('rendered-routine-icon');
    expect(icon).toHaveAttribute('data-value', 'lucide:alarm-clock');
    expect(icon).toHaveAttribute('data-color', '#3b82f6');
    expect(screen.queryByText('lucide:alarm-clock')).not.toBeInTheDocument();
  });

  it('uses the routine fallback when no icon is selected', () => {
    const { container } = render(
      <RoutineIcon routine={{ icon: null, iconColor: null }} />,
    );

    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
