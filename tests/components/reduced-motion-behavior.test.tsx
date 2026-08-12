import React from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reducedMotion } = vi.hoisted(() => ({
  reducedMotion: { current: true },
}));
const triggerHapticFeedback = vi.hoisted(() => vi.fn());

vi.mock('motion/react', () => {
  const MotionDiv = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>
  >(function MotionDiv({ animate, transition, children, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        data-motion-animate={animate === undefined ? 'none' : JSON.stringify(animate)}
        data-motion-duration={JSON.stringify(transition).includes('"duration":0') ? '0' : 'animated'}
      >
        {children}
      </div>
    );
  });
  const MotionSpan = React.forwardRef<
    HTMLSpanElement,
    React.HTMLAttributes<HTMLSpanElement> & Record<string, unknown>
  >(function MotionSpan({ animate, transition, children, ...props }, ref) {
    return (
      <span
        {...props}
        ref={ref}
        data-motion-animate={animate === undefined ? 'none' : JSON.stringify(animate)}
        data-motion-duration={JSON.stringify(transition).includes('"duration":0') ? '0' : 'animated'}
      >
        {children}
      </span>
    );
  });

  return {
    motion: { div: MotionDiv, span: MotionSpan },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/lib/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => reducedMotion.current,
}));
vi.mock('@/lib/utils/haptics', () => ({
  triggerHapticFeedback,
}));

vi.mock('@/components/ui/HoustonIcon', () => ({
  HoustonIcon: () => <span data-testid="houston-icon" />,
}));

import { TypingIndicator } from '@/components/houston/TypingIndicator';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';

describe('reduced motion behavior', () => {
  beforeEach(() => {
    reducedMotion.current = true;
    triggerHapticFeedback.mockReset();
  });

  it('renders thinking feedback without continuous dot motion', () => {
    const { container } = render(<TypingIndicator isTyping />);

    expect(screen.getByLabelText('Houston is thinking')).toBeInTheDocument();
    const dots = container.querySelectorAll(
      '[aria-label="Houston is thinking"] > [data-motion-animate="none"]',
    );
    expect(dots).toHaveLength(3);
    expect(
      Array.from(dots).every(
        (element) => (element as HTMLElement).dataset.motionDuration === '0',
      ),
    ).toBe(true);
  });

  it('makes pull-to-refresh release immediate', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn() }));

    expect(result.current.contentStyle.transition).toBe('none');
  });

  it('emits one soft tick per pull when the refresh threshold is crossed', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn() }));
    result.current.containerRef.current = { scrollTop: 0 } as HTMLDivElement;

    act(() => {
      result.current.containerProps.onTouchStart({
        touches: [{ clientY: 0 }],
      } as unknown as React.TouchEvent);
      result.current.containerProps.onTouchMove({
        touches: [{ clientY: 100 }],
        preventDefault: vi.fn(),
      } as unknown as React.TouchEvent);
      result.current.containerProps.onTouchMove({
        touches: [{ clientY: 120 }],
        preventDefault: vi.fn(),
      } as unknown as React.TouchEvent);
    });

    expect(triggerHapticFeedback).toHaveBeenCalledOnce();
    expect(triggerHapticFeedback).toHaveBeenCalledWith('refreshThreshold');
  });
});
