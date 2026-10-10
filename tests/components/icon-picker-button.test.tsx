import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconPickerButton } from '@rsocko/icon-picker/picker';

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function mockTriggerRect(rect: Partial<DOMRect>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 540,
    height: 40,
    left: 900,
    right: 964,
    top: 500,
    width: 64,
    x: 900,
    y: 500,
    toJSON: () => ({}),
    ...rect,
  });
}

describe('IconPickerButton', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens above the trigger and clamps to the viewport when space is constrained', () => {
    setViewport(1000, 600);
    mockTriggerRect({});

    render(<IconPickerButton value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Pick an icon'));

    const dialog = screen.getByRole('dialog', { name: 'Choose an icon' });
    expect(dialog.parentElement).toHaveStyle({
      height: '488px',
      left: '572px',
      top: '8px',
      width: '420px',
      visibility: 'visible',
    });
  });

  it('repositions and resizes while open when the viewport changes', () => {
    setViewport(1200, 800);
    mockTriggerRect({
      bottom: 140,
      left: 100,
      right: 164,
      top: 100,
      x: 100,
      y: 100,
    });

    render(<IconPickerButton value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Pick an icon'));

    const dialog = screen.getByRole('dialog', { name: 'Choose an icon' });
    expect(dialog.parentElement).toHaveStyle({
      height: '520px',
      left: '100px',
      top: '144px',
    });

    setViewport(1200, 400);
    act(() => window.dispatchEvent(new Event('resize')));

    expect(dialog.parentElement).toHaveStyle({
      height: '248px',
      left: '100px',
      top: '144px',
    });
  });

  it('uses the viewport as an overlay when neither side is usable', () => {
    setViewport(360, 300);
    mockTriggerRect({
      bottom: 170,
      left: 280,
      right: 344,
      top: 130,
      x: 280,
      y: 130,
    });

    render(<IconPickerButton value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Pick an icon'));

    expect(screen.getByRole('dialog', { name: 'Choose an icon' }).parentElement).toHaveStyle({
      height: '284px',
      left: '8px',
      top: '8px',
      width: '344px',
    });
  });

  it('isolates picker mouse events from trigger ancestors', () => {
    setViewport(1200, 800);
    mockTriggerRect({});
    const handleMouseDown = vi.fn((event: React.MouseEvent) => event.preventDefault());

    render(
      <div onMouseDown={handleMouseDown}>
        <IconPickerButton value={null} onChange={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByTitle('Pick an icon'));
    fireEvent.mouseDown(screen.getByRole('searchbox', { name: 'Search icons' }));

    expect(handleMouseDown).not.toHaveBeenCalled();
  });
});
