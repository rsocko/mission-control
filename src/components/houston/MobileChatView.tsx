'use client';

import type { KeyboardEventHandler, RefObject } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Send, ChevronLeft, SquarePen } from 'lucide-react';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import { MobileChatBubble } from '@/components/houston/MobileChatBubble';
import { TypingIndicator } from '@/components/houston/TypingIndicator';
import { SuggestionChip } from '@/components/ai/ChatWidgets';
import type { ChatMessage } from '@/lib/ai/chatMessageFactory';
import type { ProviderInfo } from '@/lib/ai/chatTypes';

const mobileSuggestions = [
  ["What's overdue?", "What's overdue?"],
  ['Plan my day', 'Help me plan my day — what should I focus on?'],
  ["What's critical?", 'What are my most critical items?'],
] as const;

type MobileChatViewProps = {
  input: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  loading: boolean;
  messages: ChatMessage[];
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onBack?: () => void;
  onInputChange: (value: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onNewChat?: () => void;
  onSend: (text?: string) => void | Promise<void>;
  providerInfo: ProviderInfo | null;
};

/**
 * Mobile-optimized chat view with iOS-style message bubbles.
 * Renders the shared native tool cards and shows typing indicators.
 */
export function MobileChatView({
  input,
  inputRef,
  loading,
  messages,
  messagesEndRef,
  onBack,
  onInputChange,
  onKeyDown,
  onNewChat,
  onSend,
  providerInfo,
}: MobileChatViewProps) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  return (
    <div className="flex flex-col h-full bg-[var(--surface-0)]">
      {/* Header with back + new chat */}
      <div className="flex items-center justify-between px-2 py-2 border-b border-[var(--border)] bg-[var(--surface-1)]/80 backdrop-blur-lg">
        <button
          type="button"
          onClick={onBack}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-40 min-h-[44px]"
          aria-label="Back to Houston home"
        >
          <ChevronLeft size={20} />
          <span className="text-sm font-medium">Houston</span>
        </button>
        <button
          type="button"
          onClick={onNewChat}
          disabled={loading || messages.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-40 min-h-[44px]"
          aria-label="Start new conversation"
        >
          <SquarePen size={16} />
          <span className="text-sm">New</span>
        </button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {messages.length === 0 ? (
          <EmptyState
            providerInfo={providerInfo}
            loading={loading}
            onSend={onSend}
            prefersReducedMotion={prefersReducedMotion}
          />
        ) : (
          <div className="space-y-0" role="log" aria-live="polite" aria-label="Chat messages">
            {messages.map((message, index) => {
              const prev = index > 0 ? messages[index - 1] : undefined;
              return (
                <MobileChatBubble
                  key={message.id}
                  message={message}
                  loading={loading && index === messages.length - 1}
                  previousMessage={prev}
                  timestamp={message.createdAt ? new Date(message.createdAt).toISOString() : new Date().toISOString()}
                  previousTimestamp={prev?.createdAt ? new Date(prev.createdAt).toISOString() : undefined}
                />
              );
            })}

            {/* Typing indicator when loading and last message is user */}
            {loading && messages.length > 0 && messages[messages.length - 1].role === 'user' ? (
              <TypingIndicator isTyping={true} />
            ) : null}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="p-3 border-t border-[var(--border)] bg-[var(--surface-1)]/80 backdrop-blur-lg">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Houston…"
            className="flex-1 px-3.5 py-2.5 border border-[var(--border)] rounded-2xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-transparent text-sm bg-[var(--surface-0)] text-[var(--text-primary)] min-h-[44px] max-h-[120px]"
            disabled={loading}
          />
          <button
            type="button"
            onClick={() => void onSend()}
            disabled={loading || !input.trim()}
            className="w-[44px] h-[44px] flex items-center justify-center rounded-full bg-blue-600 text-white disabled:opacity-40 transition-all active:scale-90"
            aria-label="Send message"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  providerInfo,
  loading,
  onSend,
  prefersReducedMotion,
}: {
  providerInfo: ProviderInfo | null;
  loading: boolean;
  onSend: (text?: string) => void | Promise<void>;
  prefersReducedMotion: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <motion.div
        initial={prefersReducedMotion ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 25 }}
        className="text-center"
      >
        <div className="mx-auto mb-4">
          <HoustonIcon size={48} />
        </div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-1">Houston</h2>
        <p className="text-xs text-[var(--text-muted)] mb-6">
          {providerInfo?.configured
            ? 'Your AI mission control assistant'
            : 'AI not configured — set up in Settings'}
        </p>
        {providerInfo?.configured ? (
          <div className="flex flex-wrap gap-2 justify-center">
            {mobileSuggestions.map(([label, prompt]) => (
              <SuggestionChip key={label} disabled={loading} text={label} onClick={() => void onSend(prompt)} />
            ))}
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
