'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';

type TypingIndicatorProps = {
  /** Whether the AI is currently generating a response */
  isTyping: boolean;
  /** Streaming text that appears word-by-word */
  streamingText?: string;
};

/**
 * Animated typing indicator for Houston AI.
 * Shows bouncing dots while waiting, then streams text word-by-word with a blinking cursor.
 */
export const TypingIndicator = memo(function TypingIndicator({
  isTyping,
  streamingText,
}: TypingIndicatorProps) {
  const [visibleWords, setVisibleWords] = useState<string[]>([]);
  const prevTextRef = useRef('');
  const prefersReducedMotion = usePrefersReducedMotion();

  // Word-by-word streaming effect
  useEffect(() => {
    if (!streamingText) {
      setVisibleWords([]);
      prevTextRef.current = '';
      return;
    }

    const words = streamingText.split(/(\s+)/);
    const prevWords = prevTextRef.current.split(/(\s+)/);

    // Only animate new words beyond what we've already shown
    if (words.length > prevWords.length) {
      const newWords = words.slice(prevWords.length);
      let wordIndex = 0;

      const timer = setInterval(() => {
        if (wordIndex < newWords.length) {
          setVisibleWords(prev => [...prev, newWords[wordIndex]]);
          wordIndex++;
        } else {
          clearInterval(timer);
          // Only update ref after all words have been displayed
          prevTextRef.current = streamingText;
        }
      }, 30);

      return () => {
        clearInterval(timer);
        // Sync visible words to include all pending words before next batch
        setVisibleWords(words);
        prevTextRef.current = streamingText;
      };
    } else {
      setVisibleWords(words);
      prevTextRef.current = streamingText;
    }
  }, [streamingText]);

  if (!isTyping && !streamingText) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        className="flex justify-start mt-1"
      >
        <div className="flex-shrink-0 mr-2 mt-1">
          <div className="w-7 h-7 rounded-full bg-[var(--surface-2)] flex items-center justify-center">
            <HoustonIcon size={16} />
          </div>
        </div>

        <div className="max-w-[78%]">
          {streamingText && visibleWords.length > 0 ? (
            <div className="px-3.5 py-2.5 rounded-2xl rounded-tl-sm bg-[var(--surface-2)]/80 backdrop-blur-md border border-white/[0.06]">
              <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">
                {visibleWords.join('')}
                <motion.span
                  className="inline-block w-0.5 h-3.5 bg-blue-400 ml-0.5 align-middle rounded-full"
                  animate={prefersReducedMotion ? undefined : { opacity: [1, 0] }}
                  transition={prefersReducedMotion
                    ? { duration: 0 }
                    : { duration: 0.8, repeat: Infinity, ease: 'linear' }}
                />
              </p>
            </div>
          ) : (
            <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-[var(--surface-2)]/80 backdrop-blur-md border border-white/[0.06]">
              <BouncingDots prefersReducedMotion={prefersReducedMotion} />
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
});

/** Three bouncing dots with stagger animation */
function BouncingDots({ prefersReducedMotion }: { prefersReducedMotion: boolean | null }) {
  return (
    <span className="inline-flex items-center gap-1.5" aria-label="Houston is thinking">
      {[0, 1, 2].map(i => (
        <motion.span
          key={i}
          className="w-2 h-2 rounded-full bg-gradient-to-br from-blue-400 to-purple-400"
          animate={prefersReducedMotion ? undefined : {
            y: [0, -6, 0],
            scale: [1, 1.2, 1],
          }}
          transition={prefersReducedMotion
            ? { duration: 0 }
            : {
                duration: 0.7,
                repeat: Infinity,
                delay: i * 0.2,
                ease: 'easeInOut',
              }}
        />
      ))}
    </span>
  );
}
