'use client';

import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { AssistantMarkdown } from '@/components/ai/AssistantMarkdown';
import { ToolCard } from '@/components/ai/ToolCard';
import { isTextLikePart, isToolPart, shouldHidePart, type ChatMessage } from '@/lib/ai/chatMessageFactory';
import { fadeSlideUp } from '@/lib/motion';

export function ChatMessageRow({ message, loading }: { message: ChatMessage; loading: boolean }) {
  const visibleParts = message.parts.filter(part => !shouldHidePart(part));
  const showThinking = message.role === 'assistant' && loading && visibleParts.length === 0;
  const hasToolParts = visibleParts.some(isToolPart);

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <motion.div initial="hidden" animate="show" variants={fadeSlideUp} className="max-w-[80%] rounded-lg px-4 py-2.5 bg-blue-600 text-white">
          {message.parts.map((part, index) => (isTextLikePart(part) ? <p key={`${message.id}-${index}`} className="text-sm whitespace-pre-wrap">{part.text}</p> : null))}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className={`min-w-0 ${hasToolParts ? 'w-full max-w-2xl' : 'max-w-[80%]'} space-y-2`}>
        {visibleParts.map((part, index) => {
          if (isTextLikePart(part)) {
            return (
              <motion.div key={`${message.id}-text-${index}`} initial="hidden" animate="show" variants={fadeSlideUp} className="rounded-lg px-4 py-2.5 bg-[var(--surface-2)] text-[var(--text-primary)] border border-[var(--border-subtle)]">
                <AssistantMarkdown>{part.text}</AssistantMarkdown>
              </motion.div>
            );
          }

          return isToolPart(part) ? <ToolCard key={`${message.id}-tool-${index}`} part={part} /> : null;
        })}

        {showThinking ? (
          <motion.div initial="hidden" animate="show" variants={fadeSlideUp} className="rounded-lg px-4 py-2.5 bg-[var(--surface-2)] text-[var(--text-primary)] border border-[var(--border-subtle)]">
            <p className="text-sm text-[var(--text-muted)]"><Loader2 size={12} className="inline animate-spin" /> Thinking...</p>
          </motion.div>
        ) : null}
      </div>
    </div>
  );
}
