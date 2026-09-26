import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast as sonner, type ToastT } from 'sonner';
import { Toaster } from '@/components/ui/toaster';
import { toast } from '@/lib/toast';
import { setToastPreferences } from '@/lib/toast-preferences';

let time = Date.now();
async function advance(ms = 20) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function entries() {
  return sonner.getToasts().filter((entry): entry is ToastT => !('dismiss' in entry));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
  vi.setSystemTime(time += 86_400_000);
  localStorage.clear();
  sonner.dismiss();
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  // happy-dom does not implement pointer capture.
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
});

describe('Toaster', () => {
  it('defaults bottom-left, clears the rail, and switches position live', async () => {
    render(<Toaster />);
    act(() => { toast.success('Placement'); });
    await advance();
    let list = document.querySelector('[data-sonner-toaster]');
    expect(list).toHaveAttribute('data-x-position', 'left');
    expect(list).toHaveAttribute('data-y-position', 'bottom');
    expect(list?.getAttribute('style')).toContain('var(--toast-nav-width, 0px)');
    act(() => setToastPreferences({ desktopPosition: 'top-right' }));
    await advance();
    list = document.querySelector('[data-sonner-toaster]');
    expect(list).toHaveAttribute('data-x-position', 'right');
    expect(list).toHaveAttribute('data-y-position', 'top');
  });

  it('keeps mobile top-center regardless of desktop preference', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    });
    render(<Toaster />);
    act(() => { toast.success('Mobile'); });
    await advance();
    const list = document.querySelector('[data-sonner-toaster]');
    expect(list).toHaveAttribute('data-x-position', 'center');
    expect(list).toHaveAttribute('data-y-position', 'top');
  });

  it('dismisses with the desktop close button', async () => {
    render(<Toaster />);
    act(() => { toast.success('Close me'); });
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Close toast' }));
    await advance(250);
    expect(screen.queryByText('Close me')).not.toBeInTheDocument();
  });

  it.each([
    ['left', -100, 0], ['right', 100, 0], ['up', 0, -100], ['down', 0, 100],
  ])('dismisses with a %s pointer drag', async (_direction, dx, dy) => {
    render(<Toaster />);
    act(() => { toast.success('Swipe me'); });
    await advance();
    const item = screen.getByText('Swipe me').closest('li')!;
    fireEvent.pointerDown(item, { clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerMove(item, { clientX: 200 + Number(dx) / 2, clientY: 200 + Number(dy) / 2 });
    fireEvent.pointerMove(item, { clientX: 200 + Number(dx), clientY: 200 + Number(dy) });
    fireEvent.pointerUp(item);
    await advance(250);
    expect(screen.queryByText('Swipe me')).not.toBeInTheDocument();
  });

  it('holds messages during keyboard focus, preserving their type and actions', async () => {
    render(<Toaster />);
    const action = { label: 'Undo', onClick: vi.fn() };
    act(() => { toast.success('Keyboard action', { action }); });
    await advance();
    const undo = screen.getByRole('button', { name: 'Undo' });
    fireEvent.focus(undo);
    await advance(9000);
    expect(entries()[0]).toMatchObject({ type: 'success', duration: Infinity, action });
    expect(undo).toBeInTheDocument();
    fireEvent.blur(undo, { relatedTarget: document.body });
    await advance();
    expect(entries()[0]).toMatchObject({ type: 'success', duration: 8000, action });
    await advance(8300);
    expect(screen.queryByText('Keyboard action')).not.toBeInTheDocument();
  });

  it('pauses the dismissal timer while hovered', async () => {
    render(<Toaster />);
    act(() => { toast.success('Hover to read'); });
    await advance();
    fireEvent.mouseEnter(document.querySelector('[data-sonner-toaster]')!);
    await advance(4000);
    expect(screen.getByText('Hover to read')).toBeInTheDocument();
    fireEvent.mouseLeave(document.querySelector('[data-sonner-toaster]')!);
    await advance(3300);
    expect(screen.queryByText('Hover to read')).not.toBeInTheDocument();
  });

  it('does not dismiss short drags or trigger an action when dragging the body', async () => {
    render(<Toaster />);
    const onClick = vi.fn();
    act(() => { toast.success('Short drag', { action: { label: 'Undo', onClick } }); });
    await advance();
    const item = screen.getByText('Short drag').closest('li')!;
    fireEvent.pointerDown(item, { clientX: 200, clientY: 200, button: 0 });
    await advance(500);
    fireEvent.pointerMove(item, { clientX: 205, clientY: 200 });
    fireEvent.pointerMove(item, { clientX: 210, clientY: 200 });
    fireEvent.pointerUp(item);
    await advance(250);
    expect(screen.getByText('Short drag')).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('removes existing routine messages when muted but retains Undo and errors', async () => {
    render(<Toaster />);
    act(() => {
      toast.success('Routine');
      toast.success('Undoable', { action: { label: 'Undo', onClick: vi.fn() } });
      toast.error('Important');
    });
    await advance();
    act(() => setToastPreferences({ mode: 'errors-only' }));
    expect(entries().map((entry) => entry.title)).not.toContain('Routine');
    await advance();
    await advance(300);
    expect(screen.queryByText('Routine')).not.toBeInTheDocument();
    expect(screen.getByText('Undoable')).toBeInTheDocument();
    expect(screen.getByText('Important')).toBeInTheDocument();
  });
});
