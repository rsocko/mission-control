'use client';

import { Mic, MicOff, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useVoiceCapture, type VoiceCaptureState } from '@/lib/hooks/useVoiceCapture';
import { cn } from '@/lib/utils';

interface VoiceButtonProps {
  onTranscript: (text: string) => void;
  className?: string;
}

export function VoiceButton({ onTranscript, className }: VoiceButtonProps) {
  const {
    state,
    isSupported,
    interimTranscript,
    startListening,
    stopListening,
  } = useVoiceCapture({
    onTranscript,
    onError: (msg) => toast.error(msg),
  });

  if (!isSupported) return null;

  const isListening = state === 'listening';
  const isDenied = state === 'denied';

  return (
    <div className={cn('flex flex-col items-start gap-1', className)}>
      <button
        type="button"
        onClick={isListening ? stopListening : startListening}
        aria-label={isDenied ? 'Microphone blocked' : isListening ? 'Stop voice input' : 'Start voice input'}
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all',
          isDenied
            ? 'bg-[var(--surface-2)] text-[var(--text-muted)] border border-[var(--border)] opacity-60'
            : isListening
              ? 'bg-red-500/10 text-red-500 border border-red-500/30 animate-pulse'
              : 'bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-3)]'
        )}
      >
        {isListening ? (
          <>
            <Square size={14} className="fill-current" />
            Stop
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
      {isListening && interimTranscript && (
        <p className="text-xs text-[var(--text-tertiary)] italic pl-1 max-w-[280px] truncate">
          {interimTranscript}
        </p>
      )}
    </div>
  );
}
