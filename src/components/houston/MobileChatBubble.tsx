'use client';

import { memo, useCallback, useState } from 'react';
import { motion, type Variants, useReducedMotion } from 'motion/react';
import { AssistantMarkdown } from '@/components/ai/AssistantMarkdown';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import { ToolCard } from '@/components/ai/ToolCard';
import { isTextLikePart, isToolPart, shouldHidePart, type ChatMessage } from '@/lib/ai/chatMessageFactory';

/** Time gap (ms) that triggers showing a timestamp between message groups */
const TIMESTAMP_GAP_MS = 5 * 60 * 1000;

type MobileChatBubbleProps = {
  message: ChatMessage;
  loading: boolean;
  /** Previous message for grouping logic */
  previousMessage?: ChatMessage;
  /** Timestamp of previous message (ISO string) for gap detection */
  previousTimestamp?: string;
  /** Timestamp of this message (ISO string) */
  timestamp?: string;
};

const bubbleEntryVariants: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.97 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: 'spring', stiffness: 400, damping: 28 },
  },
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function shouldShowTimestamp(current?: string, previous?: string): boolean {
  if (!current || !previous) return !!current;
  return new Date(current).getTime() - new Date(previous).getTime() > TIMESTAMP_GAP_MS;
}

export const MobileChatBubble = memo(function MobileChatBubble({
  message,
  loading,
  previousMessage,
  previousTimestamp,
  timestamp,
}: MobileChatBubbleProps) {
  const [showTime, setShowTime] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const isUser = message.role === 'user';
  const isGrouped = previousMessage?.role === message.role;
  const showGapTimestamp = shouldShowTimestamp(timestamp, previousTimestamp);

  const handleLongPress = useCallback(() => {
    setShowTime(prev => !prev);
  }, []);

  const visibleParts = message.parts.filter(part => !shouldHidePart(part));
  const showThinking = message.role === 'assistant' && loading && visibleParts.length === 0;
  const hasToolParts = visibleParts.some(isToolPart);

  return (
    <>
      {showGapTimestamp && timestamp ? (
        <div className="flex justify-center py-2">
          <span className="text-[0.625rem] text-[var(--text-muted)] bg-[var(--surface-1)]/60 backdrop-blur-sm px-2 py-0.5 rounded-full">
            {formatTimestamp(timestamp)}
          </span>
        </div>
      ) : null}

      <div
        className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${isGrouped ? 'mt-0.5' : 'mt-3'}`}
        onContextMenu={e => { e.preventDefault(); handleLongPress(); }}
      >
        {/* Assistant avatar — only on first message of group */}
        {!isUser && !isGrouped ? (
          <div className="flex-shrink-0 mr-2 mt-1">
            <div className="w-7 h-7 rounded-full bg-[var(--surface-2)] flex items-center justify-center">
              <HoustonIcon size={16} />
            </div>
          </div>
        ) : !isUser ? (
          <div className="w-7 mr-2 flex-shrink-0" />
        ) : null}

        <div className={`min-w-0 ${!isUser && hasToolParts ? 'max-w-[calc(100%-2.25rem)] flex-1' : 'max-w-[78%]'} space-y-1 ${isUser ? 'items-end' : 'items-start'}`}>
          {isUser ? (
            <motion.div
              initial={prefersReducedMotion ? "show" : "hidden"}
              animate="show"
              variants={bubbleEntryVariants}
              className={`px-3.5 py-2.5 text-sm text-white whitespace-pre-wrap
                bg-gradient-to-br from-blue-500 to-blue-600
                ${isGrouped ? 'rounded-2xl rounded-tr-md' : 'rounded-2xl rounded-tr-sm'}`}
            >
              {message.parts.map((part, i) =>
                isTextLikePart(part) ? <span key={`${message.id}-${i}`}>{part.text}</span> : null,
              )}
            </motion.div>
          ) : (
            <>
              {visibleParts.map((part, index) => {
                if (isTextLikePart(part)) {
                  return (
                    <motion.div
                      key={`${message.id}-text-${index}`}
                      initial={prefersReducedMotion ? "show" : "hidden"}
                      animate="show"
                      variants={bubbleEntryVariants}
                      className={`px-3.5 py-2.5 text-sm text-[var(--text-primary)]
                        bg-[var(--surface-2)]/80 backdrop-blur-md border border-white/[0.06]
                        ${isGrouped && index === 0 ? 'rounded-2xl rounded-tl-md' : 'rounded-2xl rounded-tl-sm'}`}
                    >
                      <AssistantMarkdown>{part.text}</AssistantMarkdown>
                    </motion.div>
                  );
                }
                return isToolPart(part) ? (
                  <div key={`${message.id}-tool-${index}`} className="w-full">
                    <ToolCard part={part} />
                  </div>
                ) : null;
              })}

              {showThinking ? (
                <motion.div
                  initial={prefersReducedMotion ? "show" : "hidden"}
                  animate="show"
                  variants={bubbleEntryVariants}
                  className="px-3.5 py-2.5 rounded-2xl rounded-tl-sm bg-[var(--surface-2)]/80 backdrop-blur-md border border-white/[0.06]"
                >
                  <TypingDots />
                </motion.div>
              ) : null}
            </>
          )}

          {/* Tap-to-show timestamp */}
          {showTime && timestamp ? (
            <motion.span
              initial={prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className={`block text-[0.625rem] text-[var(--text-muted)] mt-0.5 ${isUser ? 'text-right' : 'text-left'}`}
            >
              {formatTimestamp(timestamp)}
            </motion.span>
          ) : null}
        </div>
      </div>
    </>
  );
});

/** Inline three-dot typing indicator used within the bubble */
function TypingDots() {
  const prefersReduced = useReducedMotion();
  return (
    <span className="inline-flex items-center gap-1" aria-label="Houston is typing">
      {[0, 1, 2].map(i => (
        <motion.span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)]"
          animate={prefersReduced ? undefined : { y: [0, -4, 0] }}
          transition={prefersReduced ? { duration: 0 } : {
            duration: 0.6,
            repeat: Infinity,
            delay: i * 0.15,
            ease: 'easeInOut',
          }}
        />
      ))}
    </span>
  );
}
