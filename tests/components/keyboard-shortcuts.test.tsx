import { fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from '@/components/KeyboardShortcuts';
import { isModalDialogOpen, shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';

const shortcuts = vi.hoisted(() => ({
  push: vi.fn(),
  toggleCalm: vi.fn(),
  toggleNotificationsPanel: vi.fn(),
  toggleSidebar: vi.fn(),
  toggleZen: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: shortcuts.push }),
}));

vi.mock('@/lib/hooks/useViewMode', () => ({
  useViewMode: () => ({
    toggleCalm: shortcuts.toggleCalm,
    toggleZen: shortcuts.toggleZen,
  }),
}));

vi.mock('@/lib/hooks/useSidebarExpanded', () => ({
  useSidebarExpanded: () => ({
    toggleNotificationsPanel: shortcuts.toggleNotificationsPanel,
    toggleSidebar: shortcuts.toggleSidebar,
  }),
}));

describe('global keyboard shortcuts', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('detects only modal dialogs as shortcut-blocking surfaces', () => {
    const nonModal = document.createElement('div');
    nonModal.setAttribute('role', 'dialog');
    document.body.append(nonModal);
    expect(isModalDialogOpen()).toBe(false);

    nonModal.setAttribute('aria-modal', 'true');
    expect(isModalDialogOpen()).toBe(true);
    expect(shouldBlockGlobalShortcut(new KeyboardEvent('keydown'))).toBe(true);
  });

  it('does not enter Zen mode while a modal is open', () => {
    renderHook(() => useKeyboardShortcuts());
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);

    fireEvent.keyDown(window, { key: 'z' });

    expect(shortcuts.toggleZen).not.toHaveBeenCalled();
  });

  it('restores global shortcuts after the modal closes', () => {
    renderHook(() => useKeyboardShortcuts());

    fireEvent.keyDown(window, { key: 'z' });

    expect(shortcuts.toggleZen).toHaveBeenCalledOnce();
  });
});
