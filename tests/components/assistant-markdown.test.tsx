import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMarkdown } from '@/components/ai/AssistantMarkdown';
import { ChatMessageRow } from '@/components/ai/ChatMessageRow';
import { MobileChatBubble } from '@/components/houston/MobileChatBubble';
import type { ChatMessage } from '@/lib/ai/chatMessageFactory';

function renderMotionElement(
  tag: 'div' | 'span',
  props: React.PropsWithChildren<Record<string, unknown>>,
) {
  const { animate, children, initial, transition, variants, ...domProps } = props;
  void animate;
  void initial;
  void transition;
  void variants;
  return React.createElement(tag, domProps, children);
}

vi.mock('motion/react', () => ({
  motion: {
    div: (props: React.PropsWithChildren<Record<string, unknown>>) => renderMotionElement('div', props),
    span: (props: React.PropsWithChildren<Record<string, unknown>>) => renderMotionElement('span', props),
  },
  useReducedMotion: () => true,
}));

const assistantMessage: ChatMessage = {
  id: 'assistant-message',
  role: 'assistant',
  parts: [{ type: 'text', text: '### Shipped\n\nThis is **ready**.' }],
};

const userMessage: ChatMessage = {
  id: 'user-message',
  role: 'user',
  parts: [{ type: 'text', text: '### Keep **literal**' }],
};

describe('AssistantMarkdown', () => {
  it('renders representative GFM with responsive code and table overflow', () => {
    const { container } = render(
      <AssistantMarkdown>{`### Plan

**Bold** and [docs](https://example.com) with \`inline code\`.

- First
- Second

\`\`\`ts
const ready = true;
\`\`\`

| Item | State |
| --- | --- |
| Markdown | Ready |`}</AssistantMarkdown>,
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByText('Bold', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'rel',
      'nofollow noopener noreferrer',
    );
    expect(container.querySelector('pre')).toHaveClass('overflow-x-auto');
    expect(screen.getByRole('table').parentElement).toHaveClass('overflow-x-auto');
    expect(within(screen.getByRole('table')).getByText('Ready')).toBeInTheDocument();
    expect(container.querySelector('code')).toBeInTheDocument();
  });

  it('does not execute raw HTML or load model-provided images and rejects unsafe links', () => {
    const { container } = render(
      <AssistantMarkdown>{`<script>alert('xss')</script>

<img src="https://tracker.example/pixel.gif" onerror="alert('xss')" />

[unsafe](javascript:alert('xss'))

[protocol relative](//tracker.example/phish)

![tracking pixel](https://tracker.example/pixel.gif)`}</AssistantMarkdown>,
    );

    expect(container.querySelector('script')).not.toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('unsafe')).not.toHaveAttribute('href');
    expect(screen.getByText('protocol relative')).not.toHaveAttribute('href');
    expect(screen.getByText('[Image: tracking pixel]')).toBeInTheDocument();
  });

  it('renders partial streaming updates without replacing the message container', () => {
    const { container, rerender } = render(
      <AssistantMarkdown>Streaming **res</AssistantMarkdown>,
    );
    const messageContainer = container.firstElementChild;
    expect(screen.getByText('Streaming **res')).toBeInTheDocument();

    rerender(<AssistantMarkdown>Streaming **response**</AssistantMarkdown>);

    expect(container.firstElementChild).toBe(messageContainer);
    expect(screen.getByText('response', { selector: 'strong' })).toBeInTheDocument();
  });
});

describe('Houston assistant message surfaces', () => {
  it('uses Markdown for assistant messages on desktop and mobile', () => {
    const desktop = render(<ChatMessageRow message={assistantMessage} loading={false} />);
    expect(desktop.getByRole('heading', { level: 3, name: 'Shipped' })).toBeInTheDocument();
    expect(desktop.getByText('ready', { selector: 'strong' })).toBeInTheDocument();
    desktop.unmount();

    const mobile = render(<MobileChatBubble message={assistantMessage} loading={false} />);
    expect(mobile.getByRole('heading', { level: 3, name: 'Shipped' })).toBeInTheDocument();
    expect(mobile.getByText('ready', { selector: 'strong' })).toBeInTheDocument();
  });

  it('preserves user messages as plain text on desktop and mobile', () => {
    const desktop = render(<ChatMessageRow message={userMessage} loading={false} />);
    expect(desktop.getByText('### Keep **literal**')).toBeInTheDocument();
    expect(desktop.container.querySelector('strong')).not.toBeInTheDocument();
    desktop.unmount();

    const mobile = render(<MobileChatBubble message={userMessage} loading={false} />);
    expect(mobile.getByText('### Keep **literal**')).toBeInTheDocument();
    expect(mobile.container.querySelector('strong')).not.toBeInTheDocument();
  });
});
