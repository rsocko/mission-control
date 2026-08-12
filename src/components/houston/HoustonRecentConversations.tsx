'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { MessageSquare, ChevronRight, Clock } from 'lucide-react';
import { getCachedChatMessages } from '@/lib/ai/chatMessageFactory';
import type { ChatMessage } from '@/lib/ai/chatMessageFactory';

interface ConversationPreview {
  id: string;
  firstMessage: string;
  lastMessage: string;
  messageCount: number;
  timestamp: Date;
}

const STORAGE_KEY = 'mission-control:houston-conversations';

function getConversationPreviews(): ConversationPreview[] {
  if (typeof window === 'undefined') return [];

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ConversationPreview[];
      return parsed.map(c => ({ ...c, timestamp: new Date(c.timestamp) }));
    }
  } catch { /* ignore */ }

  // Fall back to current cached messages
  const messages = getCachedChatMessages();
  if (messages.length === 0) return [];

  return buildPreviewsFromMessages(messages);
}

function buildPreviewsFromMessages(messages: ChatMessage[]): ConversationPreview[] {
  if (messages.length === 0) return [];

  // Group by sessions (separated by gaps > 30min)
  const sessions: ChatMessage[][] = [];
  let currentSession: ChatMessage[] = [];

  for (const msg of messages) {
    if (currentSession.length === 0) {
      currentSession.push(msg);
      continue;
    }
    const lastMsg = currentSession[currentSession.length - 1];
    const gap = new Date(msg.createdAt ?? Date.now()).getTime() - new Date(lastMsg.createdAt ?? Date.now()).getTime();
    if (gap > 30 * 60 * 1000) {
      sessions.push(currentSession);
      currentSession = [msg];
    } else {
      currentSession.push(msg);
    }
  }
  if (currentSession.length > 0) sessions.push(currentSession);

  return sessions.slice(-5).reverse().map((session, i) => {
    const userMessages = session.filter(m => m.role === 'user');
    const firstUser = userMessages[0];
    const lastAssistant = session.filter(m => m.role === 'assistant').pop();

    const firstText = firstUser?.parts
      .filter(p => 'text' in p)
      .map(p => (p as { text: string }).text)
      .join(' ') || 'Conversation';

    const lastText = lastAssistant?.parts
      .filter(p => 'text' in p)
      .map(p => (p as { text: string }).text)
      .join(' ') || '';

    return {
      id: `conv-${i}`,
      firstMessage: firstText.slice(0, 80),
      lastMessage: lastText.slice(0, 100),
      messageCount: session.length,
      timestamp: new Date(session[session.length - 1].createdAt ?? Date.now()),
    };
  });
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface HoustonRecentConversationsProps {
  onResumeConversation?: () => void;
}

export function HoustonRecentConversations({ onResumeConversation }: HoustonRecentConversationsProps) {
  const [conversations, setConversations] = useState<ConversationPreview[]>([]);

  useEffect(() => {
    setConversations(getConversationPreviews());
  }, []);

  if (conversations.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.2 }}
      className="space-y-2"
    >
      <h3 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider px-1">
        Recent Conversations
      </h3>
      <div className="space-y-1.5">
        {conversations.map((conv, index) => (
          <motion.button
            key={conv.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2, delay: 0.05 * index }}
            onClick={onResumeConversation}
            className="w-full text-left rounded-xl border border-[var(--border)] bg-[var(--surface-1)]/60
              backdrop-blur-sm p-3 hover:border-[var(--accent-400)]/30 hover:bg-[var(--surface-2)]
              transition-all duration-150 active:scale-[0.98] min-h-[44px] group"
          >
            <div className="flex items-start gap-2.5">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--surface-2)] border border-[var(--border-subtle)] flex items-center justify-center">
                <MessageSquare size={14} className="text-[var(--text-tertiary)]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {conv.firstMessage}
                  </p>
                  <ChevronRight size={14} className="flex-shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent-400)] transition-colors" />
                </div>
                {conv.lastMessage && (
                  <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                    {conv.lastMessage}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <Clock size={10} />
                    {formatRelativeTime(conv.timestamp)}
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {conv.messageCount} messages
                  </span>
                </div>
              </div>
            </div>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}
