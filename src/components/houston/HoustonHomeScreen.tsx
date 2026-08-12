'use client';

import { useCallback, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { Send } from 'lucide-react';
import { HoustonGreeting } from './HoustonGreeting';
import { HoustonQuickActions } from './HoustonQuickActions';
import { HoustonRecentConversations } from './HoustonRecentConversations';
import { HoustonSuggestions } from './HoustonSuggestions';

interface HoustonHomeScreenProps {
  onStartChat: (prompt: string) => void;
  loading?: boolean;
}

/**
 * Houston Home Screen — the mobile landing for the Houston AI tab.
 * Shows greeting, quick actions, suggestions, and recent conversations.
 * Tapping any action transitions to the chat thread with the prompt pre-filled.
 * Includes a composer input for free-form chat initiation.
 */
export function HoustonHomeScreen({ onStartChat, loading = false }: HoustonHomeScreenProps) {
  const [input, setInput] = useState('');

  const handleAction = useCallback((prompt: string) => {
    onStartChat(prompt);
  }, [onStartChat]);

  const handleResumeConversation = useCallback(() => {
    onStartChat('');
  }, [onStartChat]);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput('');
    onStartChat(trimmed);
  }, [input, onStartChat]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col h-full"
    >
      <div className="flex-1 flex flex-col gap-5 p-4 pb-4 overflow-y-auto">
        <HoustonGreeting />
        <HoustonQuickActions onAction={handleAction} disabled={loading} />
        <HoustonSuggestions onAction={handleAction} disabled={loading} />
        <HoustonRecentConversations onResumeConversation={handleResumeConversation} />
      </div>

      {/* Composer pinned to bottom */}
      <div className="p-3 border-t border-[var(--border)] bg-[var(--surface-1)]/80 backdrop-blur-lg">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Houston anything…"
            className="flex-1 px-3.5 py-2.5 border border-[var(--border)] rounded-2xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-transparent text-sm bg-[var(--surface-0)] text-[var(--text-primary)] min-h-[44px] max-h-[120px]"
            disabled={loading}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className="w-[44px] h-[44px] flex items-center justify-center rounded-full bg-blue-600 text-white disabled:opacity-40 transition-all active:scale-90"
            aria-label="Send message"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
