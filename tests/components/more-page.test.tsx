import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MorePage from '@/app/more/page';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe('MorePage', () => {
  it('uses Tyrion-styled coins for Money', () => {
    render(<MorePage />);

    const moneyIcon = screen.getByRole('link', { name: 'Money' }).querySelector('svg');

    expect(moneyIcon).toHaveClass('lucide-coins', 'text-amber-400');
    expect(moneyIcon?.parentElement).toHaveClass('bg-amber-400/15');
  });
});
