import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconPicker, IconRenderer } from '@/components/ui/icon-picker';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IconRenderer', () => {
  it('inherits the theme color for uncolored monochrome icons', () => {
    render(<IconRenderer value="pin" size={16} />);

    const icon = screen.getByRole('img', { name: 'lucide:pin' });
    expect(icon.tagName).toBe('SPAN');
    expect(icon).toHaveClass('bg-current');
    expect(icon).toHaveStyle({ width: '16px', height: '16px' });
    expect(icon.style.maskImage).toContain('/lucide/pin.svg');
  });

  it('falls back when a masked (uncolored) remote icon fails to load', () => {
    render(<IconRenderer value="pin" size={16} fallback={<span data-testid="fallback">?</span>} />);

    // The masked icon renders optimistically alongside a hidden probe <img>
    // used solely to detect load failures (mask-image has no error event).
    expect(screen.getByRole('img', { name: 'lucide:pin' })).toBeInTheDocument();
    expect(screen.queryByTestId('fallback')).not.toBeInTheDocument();

    const probe = document.querySelector('img[aria-hidden="true"]');
    expect(probe).not.toBeNull();
    fireEvent.error(probe as HTMLImageElement);

    expect(screen.queryByRole('img', { name: 'lucide:pin' })).not.toBeInTheDocument();
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
  });

  it('requests the selected color when one is set', () => {
    render(<IconRenderer value="lucide:pin" size={16} color="#3b82f6" />);

    expect(screen.getByRole('img', { name: 'lucide:pin' })).toHaveAttribute(
      'src',
      expect.stringContaining('color=%233b82f6'),
    );
  });

  it('offers the theme-aware color as an explicit picker option', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const onColorChange = vi.fn();
    render(
      <IconPicker
        value="lucide:pin"
        onChange={vi.fn()}
        color="#3b82f6"
        onColorChange={onColorChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use theme color' }));
    expect(onColorChange).toHaveBeenCalledWith('');
  });
});
