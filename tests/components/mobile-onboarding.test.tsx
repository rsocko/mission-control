import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('motion/react', async () => {
  const React = await import('react');

  function createMotionComponent(tag: keyof React.JSX.IntrinsicElements) {
    return React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionComponent(props, ref) {
      const {
        children,
        variants,
        initial,
        animate,
        exit,
        transition,
        layout,
        style,
        ...rest
      } = props;

      return React.createElement(tag, { ref, style, ...rest }, children);
    });
  }

  return {
    motion: {
      div: createMotionComponent('div'),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

import { MobileOnboarding } from '@/components/mobile/MobileOnboarding';

function advanceToPermissions() {
  fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue to next step' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue to next step' }));
}

function advanceToPreferences() {
  advanceToPermissions();
  fireEvent.click(screen.getByRole('button', { name: 'Continue to preferences' }));
}

describe('MobileOnboarding', () => {
  it('renders the welcome step initially', () => {
    render(<MobileOnboarding onComplete={vi.fn()} />);

    expect(screen.getByRole('heading', { name: /welcome to mission control/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument();
  });

  it('advances steps when Continue is pressed', () => {
    render(<MobileOnboarding onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));

    expect(screen.getByText('Connect Task Sources')).toBeInTheDocument();
  });

  it('calls onComplete with no preferences when Skip is pressed', () => {
    const onComplete = vi.fn();
    render(<MobileOnboarding onComplete={onComplete} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip onboarding setup' }));

    expect(onComplete).toHaveBeenCalledWith();
  });

  it('updates permission toggle state', () => {
    render(<MobileOnboarding onComplete={vi.fn()} />);

    advanceToPermissions();

    const notificationsToggle = screen.getByRole('button', { name: 'Toggle push notifications' });
    const calendarToggle = screen.getByRole('button', { name: 'Toggle calendar access' });

    fireEvent.click(notificationsToggle);
    fireEvent.click(calendarToggle);

    expect(notificationsToggle).toHaveAttribute('aria-pressed', 'true');
    expect(calendarToggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('updates work hour preferences', () => {
    render(<MobileOnboarding onComplete={vi.fn()} />);

    advanceToPreferences();

    const startInput = screen.getByLabelText('Work hours start time');
    const endInput = screen.getByLabelText('Work hours end time');

    fireEvent.change(startInput, { target: { value: '08:30' } });
    fireEvent.change(endInput, { target: { value: '16:30' } });

    expect(startInput).toHaveValue('08:30');
    expect(endInput).toHaveValue('16:30');
  });

  it('calls onComplete with preferences on the final step', () => {
    const onComplete = vi.fn();
    render(<MobileOnboarding onComplete={onComplete} />);

    advanceToPermissions();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle push notifications' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to preferences' }));
    fireEvent.change(screen.getByLabelText('Work hours start time'), { target: { value: '08:00' } });
    fireEvent.change(screen.getByLabelText('Work hours end time'), { target: { value: '16:00' } });
    fireEvent.click(screen.getByRole('button', { name: /manual/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup and enter app' }));

    expect(onComplete).toHaveBeenCalledWith({
      workHoursStart: '08:00',
      workHoursEnd: '16:00',
      priorityDefault: 'manual',
      notificationsEnabled: true,
      calendarEnabled: false,
    });
  });

  it('renders progress dots for the current step', () => {
    const { container } = render(<MobileOnboarding onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));

    const dots = Array.from(container.querySelectorAll('div.h-2.rounded-full'));
    expect(dots).toHaveLength(5);
    expect(dots[0].className).toContain('bg-emerald-400');
    expect(dots[1].className).toContain('w-6');
  });
});
