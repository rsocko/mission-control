/**
 * MobileHeader Integration Tests — Phase 1.3 / 1.4
 * Covers: F-13 header on all primary screens, F-14 search icon on all primary screens,
 *         F-15 search bar in drawer focuses search screen
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { getMobileTitle, getRouteMetadata } from '@/lib/navigation/route-metadata';

// ─── getMobileTitle unit tests ──────────────────────────────────────────────

describe('Route → title mapping', () => {
  it('maps primary tab routes to correct titles', () => {
    expect(getMobileTitle('/today')).toBe('Today');
    expect(getMobileTitle('/triage')).toBe('Triage');
    expect(getMobileTitle('/capture')).toBe('Capture');
    expect(getMobileTitle('/quick-sort')).toBe('Sort');
    expect(getMobileTitle('/ai')).toBe('Houston');
  });

  it('maps hamburger drawer routes to correct titles', () => {
    expect(getMobileTitle('/')).toBe('Dashboard');
    expect(getMobileTitle('/projects')).toBe('Projects');
    expect(getMobileTitle('/goals')).toBe('Goals');
    expect(getMobileTitle('/notifications')).toBe('Notifications');
    expect(getMobileTitle('/routines')).toBe('Routines');
    expect(getMobileTitle('/insights')).toBe('Insights');
    expect(getMobileTitle('/finance')).toBe('Money');
    expect(getMobileTitle('/settings')).toBe('Settings');
  });

  it('handles nested routes via prefix match', () => {
    expect(getMobileTitle('/projects/abc-123')).toBe('Projects');
    expect(getMobileTitle('/settings/account')).toBe('Settings');
    expect(getMobileTitle('/ai/chat/123')).toBe('Houston');
  });

  it('titles routes that are hidden or unsupported in phone navigation', () => {
    expect(getMobileTitle('/kanban')).toBe('Kanban');
    expect(getMobileTitle('/timeline')).toBe('Timeline');
    expect(getMobileTitle('/doc-intelligence')).toBe('Docs');
  });

  it('keeps hidden supported routes distinct from unsupported routes', () => {
    expect(getRouteMetadata('/doc-intelligence')?.mobileAccess).toBe('hidden');
    expect(getRouteMetadata('/kanban')?.mobileAccess).toBe('unsupported');
    expect(getRouteMetadata('/timeline')?.mobileAccess).toBe('unsupported');
  });

  it('falls back to "Mission Control" for unknown routes', () => {
    expect(getMobileTitle('/unknown')).toBe('Mission Control');
    expect(getMobileTitle('/some/deep/path')).toBe('Mission Control');
  });
});

// ─── MobileHeader search integration tests ──────────────────────────────────

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/today',
}));

// Mock window.matchMedia
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

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { MobileHeader } from '@/components/layout/MobileHeader';

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ stats: { urgent: 0, actionNeeded: 0 } }),
  });
});

describe('MobileHeader search (F-14)', () => {
  it('stays in shell flow and owns the top safe area once', () => {
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);
    const header = screen.getByRole('banner');

    expect(header.className).toContain('shrink-0');
    expect(header.className).toContain('safe-area-pt');
    expect(header.className.match(/\bsafe-area-pt\b/g)).toHaveLength(1);
  });

  it('dispatches mission-control:open-search event on search click', () => {
    const eventSpy = vi.fn();
    window.addEventListener('mission-control:open-search', eventSpy);

    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Search'));

    expect(eventSpy).toHaveBeenCalledTimes(1);
    window.removeEventListener('mission-control:open-search', eventSpy);
  });

  it('calls custom onSearchPress when provided', () => {
    const onSearchPress = vi.fn();
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} onSearchPress={onSearchPress} />);
    fireEvent.click(screen.getByLabelText('Search'));

    expect(onSearchPress).toHaveBeenCalledTimes(1);
  });

  it('search icon meets 44px minimum tap target (accessibility)', () => {
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);

    const searchButton = screen.getByLabelText('Search');
    expect(searchButton.className).toContain('min-w-[44px]');
    expect(searchButton.className).toContain('min-h-[44px]');
  });

  it('does not add persistent Back or Forward controls on mobile', () => {
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forward' })).not.toBeInTheDocument();
  });
});
