import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isModalDialogOpen,
  MODAL_DIALOG_SELECTOR,
  shouldBlockGlobalShortcut,
} from '@/lib/keyboard-shortcuts';

describe('global keyboard shortcut policy', () => {
  it('detects rendered modal dialogs through the shared selector', () => {
    const querySelector = vi.fn().mockReturnValue({ role: 'dialog' });
    const root = { querySelector } as unknown as ParentNode;

    expect(isModalDialogOpen(root)).toBe(true);
    expect(querySelector).toHaveBeenCalledWith(MODAL_DIALOG_SELECTOR);
    expect(MODAL_DIALOG_SELECTOR).toContain('[role="alertdialog"]');
  });

  it('blocks events already handled by a local surface', () => {
    expect(shouldBlockGlobalShortcut({
      defaultPrevented: true,
    } as KeyboardEvent)).toBe(true);
  });

  it('applies the policy to global mode and quick-add shortcuts', () => {
    const globalShortcuts = readFileSync(
      resolve(process.cwd(), 'src/components/KeyboardShortcuts.tsx'),
      'utf8',
    );
    const quickAdd = readFileSync(
      resolve(process.cwd(), 'src/components/add-task/QuickAddBar.tsx'),
      'utf8',
    );
    const search = readFileSync(
      resolve(process.cwd(), 'src/components/search/SearchCommand.tsx'),
      'utf8',
    );

    expect(globalShortcuts).toContain('shouldBlockGlobalShortcut(e)');
    expect(quickAdd).toContain('shouldBlockGlobalShortcut(e)');
    expect(search).toContain('shouldBlockGlobalShortcut(event)');
  });
});
