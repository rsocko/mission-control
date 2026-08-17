import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHistoryControls } from '@/components/layout/AppHistoryControls';
import { TooltipProvider } from '@/components/ui/Tooltip';

const { back, forward, historyState } = vi.hoisted(() => ({
  back: vi.fn(),
  forward: vi.fn(),
  historyState: {
    canGoBack: false,
    canGoForward: false,
  },
}));

vi.mock('@/lib/hooks/useAppHistory', () => ({
  useAppHistory: () => ({
    ...historyState,
    position: 0,
    maxPosition: 0,
    back,
    forward,
  }),
}));

describe('AppHistoryControls', () => {
  beforeEach(() => {
    back.mockReset();
    forward.mockReset();
    historyState.canGoBack = false;
    historyState.canGoForward = false;
  });

  it('disables navigation that would leave the app-owned history range', () => {
    render(
      <TooltipProvider>
        <AppHistoryControls />
      </TooltipProvider>,
    );

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('delegates enabled navigation to the shared browser history manager', () => {
    historyState.canGoBack = true;
    historyState.canGoForward = true;
    render(
      <TooltipProvider>
        <AppHistoryControls />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));

    expect(back).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledOnce();
  });
});
