/**
 * Houston Chat Navigation Tests
 * Covers: home screen composer, back button, new chat button
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Mock motion/react to avoid animation issues in tests
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement('div', props, children),
    button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement('button', props, children),
    span: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement('span', props, children),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  useReducedMotion: () => true,
  memo: (fn: unknown) => fn,
}));

// Mock fetch for HoustonGreeting
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ stats: {} }),
}));

describe('HoustonHomeScreen', () => {
  let onStartChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onStartChat = vi.fn();
    vi.mocked(fetch).mockClear();
  });

  it('requests top-level task counts for Houston summaries', async () => {
    const { HoustonHomeScreen } = await import('@/components/houston/HoustonHomeScreen');
    render(React.createElement(HoustonHomeScreen, { onStartChat }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/tasks?status=todo&openOnly=true&parentOnly=true&countsOnly=true',
      );
      expect(fetch).toHaveBeenCalledWith(
        '/api/tasks?openOnly=true&parentOnly=true&countsOnly=true',
      );
    });
  });

  it('renders a composer input for free-form chat', async () => {
    const { HoustonHomeScreen } = await import('@/components/houston/HoustonHomeScreen');
    render(React.createElement(HoustonHomeScreen, { onStartChat }));

    const textarea = screen.getByPlaceholderText('Ask Houston anything…');
    expect(textarea).toBeDefined();
  });

  it('calls onStartChat with typed text when submit is clicked', async () => {
    const { HoustonHomeScreen } = await import('@/components/houston/HoustonHomeScreen');
    render(React.createElement(HoustonHomeScreen, { onStartChat }));

    const textarea = screen.getByPlaceholderText('Ask Houston anything…');
    fireEvent.change(textarea, { target: { value: 'Hello Houston' } });

    const sendButton = screen.getByLabelText('Send message');
    fireEvent.click(sendButton);

    expect(onStartChat).toHaveBeenCalledWith('Hello Houston');
  });

  it('does not call onStartChat when input is empty', async () => {
    const { HoustonHomeScreen } = await import('@/components/houston/HoustonHomeScreen');
    render(React.createElement(HoustonHomeScreen, { onStartChat }));

    const sendButton = screen.getByLabelText('Send message');
    fireEvent.click(sendButton);

    expect(onStartChat).not.toHaveBeenCalled();
  });
});

describe('MobileChatView header', () => {
  it('renders back and new chat buttons', async () => {
    const { MobileChatView } = await import('@/components/houston/MobileChatView');
    const props = {
      input: '',
      inputRef: { current: null },
      loading: false,
      messages: [],
      messagesEndRef: { current: null },
      onBack: vi.fn(),
      onInputChange: vi.fn(),
      onKeyDown: vi.fn(),
      onNewChat: vi.fn(),
      onSend: vi.fn(),
      providerInfo: { configured: true, provider: 'openai' },
    };
    render(React.createElement(MobileChatView, props));

    expect(screen.getByLabelText('Back to Houston home')).toBeDefined();
    expect(screen.getByLabelText('Start new conversation')).toBeDefined();
  });

  it('calls onBack when back button is clicked', async () => {
    const { MobileChatView } = await import('@/components/houston/MobileChatView');
    const onBack = vi.fn();
    const props = {
      input: '',
      inputRef: { current: null },
      loading: false,
      messages: [],
      messagesEndRef: { current: null },
      onBack,
      onInputChange: vi.fn(),
      onKeyDown: vi.fn(),
      onNewChat: vi.fn(),
      onSend: vi.fn(),
      providerInfo: { configured: true, provider: 'openai' },
    };
    render(React.createElement(MobileChatView, props));

    fireEvent.click(screen.getByLabelText('Back to Houston home'));
    expect(onBack).toHaveBeenCalled();
  });

  it('disables back and new chat buttons when loading', async () => {
    const { MobileChatView } = await import('@/components/houston/MobileChatView');
    const props = {
      input: '',
      inputRef: { current: null },
      loading: true,
      messages: [{ id: '1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }], createdAt: new Date() }],
      messagesEndRef: { current: null },
      onBack: vi.fn(),
      onInputChange: vi.fn(),
      onKeyDown: vi.fn(),
      onNewChat: vi.fn(),
      onSend: vi.fn(),
      providerInfo: { configured: true, provider: 'openai' },
    };
    render(React.createElement(MobileChatView, props));

    const backBtn = screen.getByLabelText('Back to Houston home') as HTMLButtonElement;
    const newBtn = screen.getByLabelText('Start new conversation') as HTMLButtonElement;
    expect(backBtn.disabled).toBe(true);
    expect(newBtn.disabled).toBe(true);
  });
});
