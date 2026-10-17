import { render, screen } from '@testing-library/react';
import { Pin } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { SidebarNavItem } from '@/components/sidebar/SidebarNavItem';

describe('SidebarNavItem', () => {
  it('overlays a trailing action without reserving row width', () => {
    render(
      <SidebarNavItem
        icon={<span aria-hidden="true">I</span>}
        label="A long source name"
        count={42}
        overlayAction={<button type="button" aria-label="Pin source"><Pin size={12} /></button>}
      />,
    );

    const pinButton = screen.getByRole('button', { name: 'Pin source' });
    const overlay = pinButton.parentElement;
    const count = screen.getByText('42');

    expect(overlay).toHaveClass('absolute', 'right-1');
    expect(count).toHaveClass('group-hover/nav:opacity-0', 'group-focus-within/nav:opacity-0');
  });

  it('keeps the count hidden when the overlaid action is persistent', () => {
    render(
      <SidebarNavItem
        icon={<span aria-hidden="true">I</span>}
        label="Pinned source"
        count={42}
        overlayAction={<button type="button" aria-label="Unpin source"><Pin size={12} /></button>}
        overlayActionVisible
      />,
    );

    expect(screen.getByText('42')).toHaveClass('opacity-0');
  });
});
