/**
 * MobileBottomNav Tests — Navigation Overhaul Phase 1
 * Covers: F-1 tab layout, F-2 Houston tab, F-3 Sort tab,
 *         F-4 elevated Capture, F-5 badge counts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// Mock next/navigation
let mockPathname = '/today';
const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockRouterPush }),
}));

let voiceState = 'idle';
let voiceTranscriptHandler: ((text: string) => void) | undefined;
let voiceEndHandler: (() => void) | undefined;
const mockStartListening = vi.fn();
const mockStopListening = vi.fn();
vi.mock('@/lib/hooks/useVoiceCapture', () => ({
  useVoiceCapture: ({
    onTranscript,
    onEnd,
  }: {
    onTranscript?: (text: string) => void;
    onEnd?: () => void;
  }) => {
    voiceTranscriptHandler = onTranscript;
    voiceEndHandler = onEnd;
    return {
      state: voiceState,
      isSupported: true,
      interimTranscript: '',
      startListening: mockStartListening,
      stopListening: mockStopListening,
    };
  },
}));

// Mock window.matchMedia for mobile viewport (jsdom doesn't implement it)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: query === '(max-width: 639px)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock fetch for badge counts
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock HoustonIcon as a simple SVG placeholder
vi.mock('@/components/ui/HoustonIcon', () => ({
  HoustonIcon: ({ size, className }: { size?: number; className?: string }) => (
    <svg data-testid="houston-icon" width={size} height={size} className={className} />
  ),
}));

// Minimal next/link mock
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { MobileBottomNav } from '@/components/layout/MobileBottomNav';

beforeEach(() => {
  mockPathname = '/today';
  voiceState = 'idle';
  voiceTranscriptHandler = undefined;
  voiceEndHandler = undefined;
  mockRouterPush.mockReset();
  mockStartListening.mockReset();
  mockStopListening.mockReset();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ stats: { pending: 0 }, counts: { no_priority: 0, no_effort: 0, no_tags: 0 } }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MobileBottomNav', () => {
  it('renders all 5 tabs: Today, Triage, Capture, Sort, Houston', () => {
    render(<MobileBottomNav />);
    expect(screen.getByText('Today')).toBeDefined();
    expect(screen.getByText('Triage')).toBeDefined();
    expect(screen.getByText('Capture')).toBeDefined();
    expect(screen.getByText('Sort')).toBeDefined();
    expect(screen.getByText('Houston')).toBeDefined();
  });

  it('links to correct routes', () => {
    render(<MobileBottomNav />);
    const links = screen.getAllByRole('link');
    const hrefs = links.map(l => l.getAttribute('href'));
    expect(hrefs).toContain('/today');
    expect(hrefs).toContain('/triage');
    expect(hrefs).toContain('/capture');
    expect(hrefs).toContain('/quick-sort');
    expect(hrefs).toContain('/ai');
  });

  it('does not render More or Inbox tabs', () => {
    render(<MobileBottomNav />);
    expect(screen.queryByText('More')).toBeNull();
    expect(screen.queryByText('Inbox')).toBeNull();
    expect(screen.queryByText('Quick Sort')).toBeNull();
  });

  it('uses custom HoustonIcon for Houston tab', () => {
    render(<MobileBottomNav />);
    expect(screen.getByTestId('houston-icon')).toBeDefined();
  });

  it('marks active tab with aria-current=page', () => {
    mockPathname = '/triage';
    render(<MobileBottomNav />);
    const triageLink = screen.getByText('Triage').closest('a');
    expect(triageLink?.getAttribute('aria-current')).toBe('page');
    const todayLink = screen.getByText('Today').closest('a');
    expect(todayLink?.getAttribute('aria-current')).toBeNull();
  });

  it('renders Capture button with elevated styling (-mt-4)', () => {
    render(<MobileBottomNav />);
    const captureLink = screen.getByText('Capture').closest('a');
    expect(captureLink?.className).toContain('-mt-4');
  });

  it('keeps a stop control visible after receiving a final voice transcript', () => {
    vi.useFakeTimers();
    voiceState = 'listening';
    render(<MobileBottomNav />);

    const captureLink = screen.getByRole('link', { name: 'Capture — hold to dictate' });
    fireEvent.touchStart(captureLink);
    act(() => vi.advanceTimersByTime(500));

    const stopButton = screen.getByRole('button', { name: 'Stop voice capture' });
    expect(stopButton.className).toContain('min-h-[44px]');

    act(() => voiceTranscriptHandler?.('Buy'));

    expect(screen.getByRole('button', { name: 'Stop voice capture' })).toBeDefined();
    expect(screen.getByText('Buy')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Stop voice capture' }));

    expect(mockStopListening).toHaveBeenCalledOnce();
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stopping voice capture' })).toBeDisabled();

    act(() => {
      voiceTranscriptHandler?.('milk');
      voiceEndHandler?.();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/capture?shared_title=Buy%20milk');
  });

  it('renders badge when triage count > 0', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/triage')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { pending: 5 }, totalFiltered: 5 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ counts: { no_priority: 3, no_effort: 0, no_tags: 0 } }),
      });
    });

    const { findByText } = render(<MobileBottomNav />);
    // Badge should appear after fetch resolves
    const badge = await findByText('5');
    expect(badge).toBeDefined();
    expect(badge.className).toContain('bg-red-500');
  });

  it('renders amber badge for sort count > 0', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/triage')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { pending: 0 } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ counts: { no_priority: 7, no_effort: 2, no_tags: 1 } }),
      });
    });

    const { findByText } = render(<MobileBottomNav />);
    // Uses no_priority only (avoids double-counting tasks missing multiple fields)
    const badge = await findByText('7');
    expect(badge).toBeDefined();
    expect(badge.className).toContain('bg-amber-400');
  });

  it('caps badge display at 99+', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/triage')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { pending: 150 } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ counts: { no_priority: 0, no_effort: 0, no_tags: 0 } }),
      });
    });

    const { findByText } = render(<MobileBottomNav />);
    const badge = await findByText('99+');
    expect(badge).toBeDefined();
  });

  it('meets 44px minimum tap target requirement', () => {
    render(<MobileBottomNav />);
    const links = screen.getAllByRole('link');
    links.forEach(link => {
      expect(link.className).toContain('min-h-[44px]');
    });
  });

  it('does not show badges when counts are zero', () => {
    render(<MobileBottomNav />);
    // With default mock returning 0 counts, no badge aria-labels should exist
    expect(screen.queryByLabelText(/items/)).toBeNull();
  });

  it('handles fetch failures gracefully without crashing', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    render(<MobileBottomNav />);
    // Component should still render all tabs
    expect(screen.getByText('Today')).toBeDefined();
    expect(screen.getByText('Triage')).toBeDefined();
    expect(screen.getByText('Sort')).toBeDefined();
    // No badges should appear
    expect(screen.queryByLabelText(/items/)).toBeNull();
  });

  it('handles partial API failure (one endpoint down)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/triage')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stats: { pending: 3 } }),
        });
      }
      // Sort API fails
      return Promise.reject(new Error('Sort API down'));
    });

    const { findByText } = render(<MobileBottomNav />);
    // Triage badge should still appear
    const badge = await findByText('3');
    expect(badge).toBeDefined();
    expect(badge.className).toContain('bg-red-500');
  });
});
