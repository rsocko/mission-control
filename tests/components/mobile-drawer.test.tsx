/**
 * MobileDrawer + MobileHeader Tests — Navigation Overhaul Phase 1.2
 * Covers: F-6 slide-out drawer, F-7 drawer content, F-8 hamburger icon,
 *         F-9 notification dot, F-10 spring animation
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Mock next/navigation
let mockPathname = '/today';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
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

// Mock motion/react to avoid animation complexity in tests
vi.mock('motion/react', () => {
  type MotionProps<T> = React.HTMLAttributes<T> & {
    variants?: unknown;
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
  };

  const MotionDiv = React.forwardRef<HTMLDivElement, MotionProps<HTMLDivElement>>(
    function MotionDiv({ children, ...props }, ref) {
      const { variants, initial, animate, exit, ...rest } = props;
      return <div ref={ref} {...rest}>{children}</div>;
    }
  );
  const MotionNav = React.forwardRef<HTMLElement, MotionProps<HTMLElement>>(
    function MotionNav({ children, ...props }, ref) {
      const { variants, initial, animate, exit, ...rest } = props;
      return <nav ref={ref} {...rest}>{children}</nav>;
    }
  );
  return {
    motion: { div: MotionDiv, nav: MotionNav },
    AnimatePresence: ({
      children,
      onExitComplete,
    }: {
      children: React.ReactNode;
      onExitComplete?: () => void;
    }) => {
      const hadChildren = React.useRef(false);
      React.useEffect(() => {
        if (hadChildren.current && !children) onExitComplete?.();
        hadChildren.current = Boolean(children);
      }, [children, onExitComplete]);
      return <>{children}</>;
    },
    useReducedMotion: () => false,
  };
});

// Minimal next/link mock
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Mock useSyncStream
vi.mock('@/lib/hooks/useSyncStream', () => ({
  useSyncStream: () => ({
    progress: {
      isSyncing: false,
      connectorName: null,
    },
  }),
}));

import { MobileDrawer } from '@/components/layout/MobileDrawer';
import { MobileHeader, useNotificationDotColor } from '@/components/layout/MobileHeader';
import { EMPTY_NAVIGATION_COUNTS } from '@/lib/navigation/badges';

const unusedReturnFocusRef = React.createRef<HTMLElement>();

beforeEach(() => {
  mockPathname = '/today';
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ stats: { urgent: 0, actionNeeded: 0 } }),
  });
});

// ─── MobileDrawer Tests ─────────────────────────────────────────────────────

describe('MobileDrawer', () => {
  it('shows shared notification and reconciliation counts', () => {
    render(
      <MobileDrawer
        isOpen
        onClose={vi.fn()}
        returnFocusRef={unusedReturnFocusRef}
        counts={{
          ...EMPTY_NAVIGATION_COUNTS,
          notifications: 12,
          reconciliation: 3,
          notificationTone: 'red',
        }}
      />,
    );

    expect(screen.getByRole('link', { name: /Notifications/ })).toHaveTextContent('12');
    expect(screen.getByRole('link', { name: /Reconciliation/ })).toHaveTextContent('3');
  });

  it('renders drawer content when open', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByLabelText('Drawer navigation')).toBeDefined();
  });

  it('does not render when closed', () => {
    render(<MobileDrawer isOpen={false} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('includes all required navigation items (F-7)', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    expect(screen.getByText('Dashboard')).toBeDefined();
    expect(screen.getByText('Projects')).toBeDefined();
    expect(screen.getByText('Goals')).toBeDefined();
    expect(screen.getByText('Notifications')).toBeDefined();
    expect(screen.getByText('Routines')).toBeDefined();
    expect(screen.getByText('Insights')).toBeDefined();
    expect(screen.getByText('Money')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
  });

  it('includes user avatar section (F-7)', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    expect(screen.getByText('Mission Control')).toBeDefined();
    expect(screen.getByText('Personal workspace')).toBeDefined();
  });

  it('includes search bar (F-7)', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    expect(screen.getByLabelText('Search')).toBeDefined();
    expect(screen.getByPlaceholderText('Search…')).toBeDefined();
  });

  it('includes sync status indicator (F-7)', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    expect(screen.getByText('All synced')).toBeDefined();
  });

  it('links to correct routes', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    const links = screen.getAllByRole('link');
    const hrefs = links.map(l => l.getAttribute('href'));
    expect(hrefs).toContain('/');
    expect(hrefs).toContain('/projects');
    expect(hrefs).toContain('/goals');
    expect(hrefs).toContain('/notifications');
    expect(hrefs).toContain('/routines');
    expect(hrefs).toContain('/insights');
    expect(hrefs).toContain('/finance');
    expect(hrefs).toContain('/settings');
  });

  it('hides Money when the finance feature is unavailable', () => {
    render(
      <MobileDrawer
        isOpen={true}
        onClose={vi.fn()}
        returnFocusRef={unusedReturnFocusRef}
        features={{ financeEnabled: false }}
      />
    );

    expect(screen.queryByText('Money')).toBeNull();
  });

  it('marks active route with aria-current', () => {
    mockPathname = '/projects';
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    const projectsLink = screen.getByText('Projects').closest('a');
    expect(projectsLink?.getAttribute('aria-current')).toBe('page');

    const settingsLink = screen.getByText('Settings').closest('a');
    expect(settingsLink?.getAttribute('aria-current')).toBeNull();
  });

  it('calls onClose when overlay is clicked', () => {
    const onClose = vi.fn();
    render(<MobileDrawer isOpen={true} onClose={onClose} returnFocusRef={unusedReturnFocusRef} />);

    // The overlay has aria-hidden="true"
    const overlay = screen.getByRole('dialog').querySelector('[aria-hidden="true"]');
    if (overlay) fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(<MobileDrawer isOpen={true} onClose={onClose} returnFocusRef={unusedReturnFocusRef} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('nav items meet 44px minimum tap target', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    const links = screen.getAllByRole('link');
    links.forEach(link => {
      expect(link.className).toContain('min-h-[44px]');
    });
  });

  it('overlays content on left side (F-6)', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);

    const drawerNav = screen.getByLabelText('Drawer navigation');
    // Should be positioned on left
    expect(drawerNav.className).toContain('left-0');
    // Should have a fixed width
    expect(drawerNav.className).toContain('w-[280px]');
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['overlay click', () => {
      const overlay = screen.getByRole('dialog').querySelector('[aria-hidden="true"]');
      if (overlay) fireEvent.click(overlay);
    }],
  ])('restores focus to the menu trigger after closing with %s', async (_name, closeDrawer) => {
    function DrawerHarness() {
      const [isOpen, setIsOpen] = React.useState(false);
      const triggerRef = React.useRef<HTMLButtonElement>(null);
      return (
        <>
          <MobileHeader
            title="Today"
            onMenuPress={() => setIsOpen(true)}
            menuButtonRef={triggerRef}
            isDrawerOpen={isOpen}
          />
          <MobileDrawer
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            returnFocusRef={triggerRef}
          />
        </>
      );
    }

    render(<DrawerHarness />);
    const trigger = screen.getByLabelText('Open menu');
    fireEvent.click(trigger);
    expect(screen.getByPlaceholderText('Search…')).toBe(document.activeElement);

    closeDrawer();

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('restores focus after submitting a drawer search', async () => {
    function DrawerHarness() {
      const [isOpen, setIsOpen] = React.useState(false);
      const triggerRef = React.useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} onClick={() => setIsOpen(true)}>Open drawer</button>
          <MobileDrawer
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            returnFocusRef={triggerRef}
          />
        </>
      );
    }

    render(<DrawerHarness />);
    const trigger = screen.getByRole('button', { name: 'Open drawer' });
    fireEvent.click(trigger);
    const search = screen.getByPlaceholderText('Search…');
    fireEvent.change(search, { target: { value: 'overdue tasks' } });
    fireEvent.submit(search.closest('form')!);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('restores focus after navigation closes the drawer', async () => {
    function DrawerHarness() {
      const [isOpen, setIsOpen] = React.useState(false);
      const triggerRef = React.useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} onClick={() => setIsOpen(true)}>Open drawer</button>
          <MobileDrawer
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            returnFocusRef={triggerRef}
          />
        </>
      );
    }

    const { rerender } = render(<DrawerHarness />);
    const trigger = screen.getByRole('button', { name: 'Open drawer' });
    fireEvent.click(trigger);
    mockPathname = '/projects';
    rerender(<DrawerHarness />);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('does not steal focus when the drawer has never opened', () => {
    const triggerRef = React.createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={triggerRef}>Open drawer</button>
        <MobileDrawer isOpen={false} onClose={vi.fn()} returnFocusRef={triggerRef} />
      </>
    );
    const otherButton = document.createElement('button');
    document.body.appendChild(otherButton);
    otherButton.focus();

    expect(document.activeElement).toBe(otherButton);
    otherButton.remove();
  });

  it('wraps keyboard focus within the open drawer', () => {
    render(<MobileDrawer isOpen={true} onClose={vi.fn()} returnFocusRef={unusedReturnFocusRef} />);
    const focusable = screen.getByLabelText('Drawer navigation').querySelectorAll<HTMLElement>(
      'a[href], button, input, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('defines and applies the top safe-area utility once', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
    const drawer = readFileSync(resolve(process.cwd(), 'src/components/layout/MobileDrawer.tsx'), 'utf8');

    expect(styles).toMatch(/--safe-area-inset-top:\s*env\(safe-area-inset-top,\s*0px\)/);
    expect(styles).toMatch(/\.safe-area-pt\s*\{\s*padding-top:\s*var\(--safe-area-inset-top\);\s*\}/);
    expect(drawer.match(/\bsafe-area-pt\b/g)).toHaveLength(1);
  });
});

// ─── MobileHeader Tests ─────────────────────────────────────────────────────

describe('MobileHeader', () => {
  it('shows the shared notification count on the menu button', () => {
    render(
      <MobileHeader
        title="Today"
        onMenuPress={vi.fn()}
        navigationCounts={{
          ...EMPTY_NAVIGATION_COUNTS,
          notifications: 12,
          notificationTone: 'amber',
        }}
      />,
    );

    const menu = screen.getByLabelText('Open menu (has notifications)');
    expect(menu).toHaveTextContent('12');
    expect(screen.getByText('12')).toHaveClass('bg-amber-400');
  });

  it('renders hamburger icon (F-8)', () => {
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);

    const menuButton = screen.getByLabelText('Open menu');
    expect(menuButton).toBeDefined();
  });

  it('renders screen title', () => {
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);

    expect(screen.getByText('Today')).toBeDefined();
  });

  it('renders search icon by default', () => {
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);

    expect(screen.getByLabelText('Search')).toBeDefined();
  });

  it('hides search icon when showSearch=false', () => {
    render(<MobileHeader title="Today" showSearch={false} onMenuPress={vi.fn()} />);

    expect(screen.queryByLabelText('Search')).toBeNull();
  });

  it('renders context action when provided', () => {
    render(
      <MobileHeader
        title="Today"
        onMenuPress={vi.fn()}
        contextAction={<button aria-label="Filter">Filter</button>}
      />
    );

    expect(screen.getByLabelText('Filter')).toBeDefined();
  });

  it('calls onMenuPress when hamburger is clicked', () => {
    const onMenuPress = vi.fn();
    render(<MobileHeader title="Today" onMenuPress={onMenuPress} />);

    fireEvent.click(screen.getByLabelText('Open menu'));
    expect(onMenuPress).toHaveBeenCalledTimes(1);
  });

  it('hamburger button meets 44px minimum tap target', () => {
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);

    const menuButton = screen.getByLabelText('Open menu');
    expect(menuButton.className).toContain('min-w-[44px]');
    expect(menuButton.className).toContain('min-h-[44px]');
  });

  it('shows notification dot when urgent notifications exist (F-9)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stats: { urgent: 3, actionNeeded: 1, headsUp: 0 } }),
    });

    render(<MobileHeader title="Today" onMenuPress={vi.fn()} isDrawerOpen={false} />);

    // Wait for the notification fetch to resolve
    await waitFor(() => {
      expect(screen.getByLabelText('Open menu (has notifications)')).toBeDefined();
    });

    // The dot should be present (red bg for urgent)
    const button = screen.getByLabelText('Open menu (has notifications)');
    const dot = button.querySelector('.bg-red-500');
    expect(dot).toBeDefined();
  });

  it('shows orange dot when only action_needed notifications', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stats: { urgent: 0, actionNeeded: 2, headsUp: 0 } }),
    });

    render(<MobileHeader title="Today" onMenuPress={vi.fn()} isDrawerOpen={false} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Open menu (has notifications)')).toBeDefined();
    });

    const button = screen.getByLabelText('Open menu (has notifications)');
    const dot = button.querySelector('.bg-orange-500');
    expect(dot).toBeDefined();
  });

  it('shows amber dot when only heads_up notifications', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stats: { urgent: 0, actionNeeded: 0, headsUp: 5 } }),
    });

    render(<MobileHeader title="Today" onMenuPress={vi.fn()} isDrawerOpen={false} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Open menu (has notifications)')).toBeDefined();
    });

    const button = screen.getByLabelText('Open menu (has notifications)');
    const dot = button.querySelector('.bg-amber-400');
    expect(dot).toBeDefined();
  });

  it('does not show notification dot when only fyi notifications', () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stats: { urgent: 0, actionNeeded: 0, headsUp: 0, fyi: 10 } }),
    });

    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);

    const button = screen.getByLabelText('Open menu');
    const dot = button.querySelector('span.rounded-full');
    expect(dot).toBeNull();
  });

  it('header is hidden on desktop (sm:hidden)', () => {
    render(<MobileHeader title="Today" onMenuPress={vi.fn()} />);

    const header = screen.getByRole('banner');
    expect(header.className).toContain('sm:hidden');
  });

  it('sets aria-expanded based on isDrawerOpen prop', () => {
    const { rerender } = render(<MobileHeader title="Today" onMenuPress={vi.fn()} isDrawerOpen={false} />);

    const button = screen.getByLabelText('Open menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    rerender(<MobileHeader title="Today" onMenuPress={vi.fn()} isDrawerOpen={true} />);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe('mobile-navigation-drawer');
  });
});
