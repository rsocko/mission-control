'use client';

import { LoaderCircle, Mic, MicOff, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useVoiceCapture } from '@/lib/hooks/useVoiceCapture';
import { cn } from '@/lib/utils';
import styles from './VoiceButton.module.css';

interface VoiceButtonProps {
  onTranscript: (text: string) => void;
  className?: string;
}

export function VoiceButton({ onTranscript, className }: VoiceButtonProps) {
  const {
    state,
    isSupported,
    transcript,
    interimTranscript,
    startListening,
    stopListening,
  } = useVoiceCapture({
    onTranscript,
    onError: (msg) => toast.error(msg),
  });

  if (!isSupported) return null;

  const isListening = state === 'listening';
  const isStarting = state === 'starting';
  const isActive = isStarting || isListening;
  const isDenied = state === 'denied';
  const displayedTranscript = [transcript, interimTranscript.trim()]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cn('flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end', className)}>
      <button
        type="button"
        onClick={isActive ? stopListening : startListening}
        aria-label={
          isDenied
            ? 'Microphone blocked'
            : isListening
              ? 'Stop voice input'
              : isStarting
                ? 'Cancel voice input'
                : 'Start voice input'
        }
        aria-pressed={isActive}
        className={cn(
          'flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-xs font-semibold transition-[background-color,border-color,color,box-shadow]',
          isDenied
            ? 'bg-[var(--surface-2)] text-[var(--text-muted)] border border-[var(--border)] opacity-60'
            : isListening
              ? 'border-red-500 bg-red-600 text-white shadow-[0_4px_14px_rgba(220,38,38,0.22)]'
              : isStarting
                ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/10 text-[var(--accent-400)]'
              : 'bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-3)]'
        )}
      >
        {isListening ? (
          <>
            <Square size={14} className="fill-current" />
            Stop
          </>
        ) : isStarting ? (
          <>
            <LoaderCircle size={14} className="animate-spin" />
            Starting…
          </>
        ) : isDenied ? (
          <>
            <MicOff size={14} />
            Blocked
          </>
        ) : (
          <>
            <Mic size={14} />
            Voice
          </>
        )}
      </button>
      {isActive && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'w-full rounded-xl border px-3 py-3 sm:w-[280px]',
            isListening
              ? 'border-red-500/30 bg-red-500/[0.07]'
              : 'border-[var(--accent-500)]/30 bg-[var(--accent-500)]/[0.07]',
          )}
        >
          <div className="flex items-center gap-2">
            {isListening ? (
              <span className={cn(styles.waveform, 'text-red-400')} aria-hidden="true">
                {Array.from({ length: 7 }, (_, index) => (
                  <span className={styles.bar} key={index} />
                ))}
              </span>
            ) : (
              <LoaderCircle
                size={16}
                className="shrink-0 animate-spin text-[var(--accent-400)]"
                aria-hidden="true"
              />
            )}
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              {isListening ? 'Listening now' : 'Preparing microphone'}
            </span>
          </div>
          <p className="mt-2 text-sm leading-5 text-[var(--text-secondary)]">
            {isListening
              ? displayedTranscript || 'Start speaking — your words will appear here.'
              : 'Approve microphone access if your browser asks.'}
          </p>
          {isListening && (
            <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">
              Live transcription · Tap Stop when finished
            </p>
          )}
        </div>
      )}
    </div>
  );
}
