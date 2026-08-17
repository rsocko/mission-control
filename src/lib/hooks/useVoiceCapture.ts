'use client';

import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react';

export type VoiceCaptureState = 'idle' | 'listening' | 'unsupported' | 'denied';

interface UseVoiceCaptureOptions {
  onTranscript?: (text: string) => void;
  onInterimTranscript?: (text: string) => void;
  onError?: (error: string) => void;
  onEnd?: () => void;
  lang?: string;
}

interface UseVoiceCaptureReturn {
  state: VoiceCaptureState;
  isSupported: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => Promise<void>;
  stopListening: () => void;
  resetTranscript: () => void;
}

function isInstalledEdgePwa(): boolean {
  return /\bEdg(?:A|iOS)?\//.test(navigator.userAgent)
    && window.matchMedia?.('(display-mode: standalone)').matches === true;
}

const subscribeToSpeechRecognitionSupport = () => () => {};
const getSpeechRecognitionSupport = () =>
  'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
const getServerSpeechRecognitionSupport = () => false;

export function useVoiceCapture(options: UseVoiceCaptureOptions = {}): UseVoiceCaptureReturn {
  const { onTranscript, onInterimTranscript, onError, onEnd, lang = 'en-US' } = options;
  const [state, setState] = useState<VoiceCaptureState>('idle');
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const microphonePreflightRef = useRef<Promise<'ready' | 'denied'> | null>(null);
  const startRequestRef = useRef(0);
  const suppressedEndRef = useRef(new WeakSet<SpeechRecognition>());
  const isSupported = useSyncExternalStore(
    subscribeToSpeechRecognitionSupport,
    getSpeechRecognitionSupport,
    getServerSpeechRecognitionSupport,
  );

  useEffect(() => {
    const suppressedEnds = suppressedEndRef.current;
    return () => {
      startRequestRef.current += 1;
      if (recognitionRef.current) {
        suppressedEnds.add(recognitionRef.current);
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setState('unsupported');
      return;
    }

    const requestId = ++startRequestRef.current;

    // Guard against double-start
    if (recognitionRef.current) {
      suppressedEndRef.current.add(recognitionRef.current);
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    // Edge installed apps need one explicit media grant before SpeechRecognition.
    // Other browsers should use their native recognition permission flow.
    if (
      isInstalledEdgePwa()
      && navigator.mediaDevices?.getUserMedia
    ) {
      microphonePreflightRef.current ??= navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(stream => {
          stream.getTracks().forEach(track => track.stop());
          return 'ready' as const;
        })
        .catch(err => {
          if (err instanceof DOMException && err.name === 'NotAllowedError') {
            microphonePreflightRef.current = null;
            return 'denied' as const;
          }
          // SpeechRecognition may still work when media capture itself is unavailable.
          return 'ready' as const;
        });

      const preflightResult = await microphonePreflightRef.current;
      if (requestId !== startRequestRef.current) {
        return;
      }
      if (preflightResult === 'denied') {
        setState('denied');
        onError?.('Microphone permission denied. Check your browser or system settings.');
        onEnd?.();
        return;
      }
    }

    if (requestId !== startRequestRef.current) return;

    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
      setState('unsupported');
      return;
    }
    const recognition = new SpeechRecognitionAPI();

    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setState('listening');

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let newFinal = '';
      let interim = '';

      // Only process from resultIndex to avoid re-processing earlier results
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          newFinal += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (newFinal) {
        setTranscript(prev => prev ? `${prev} ${newFinal}` : newFinal);
        onTranscript?.(newFinal);
      }
      setInterimTranscript(interim);
      onInterimTranscript?.(interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'not-allowed') {
        setState('denied');
        onError?.('Microphone access was blocked. Please allow microphone in site settings.');
      } else if (event.error !== 'aborted') {
        setState('idle');
        onError?.(`Speech recognition error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      if (suppressedEndRef.current.has(recognition)) return;
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      setState('idle');
      setInterimTranscript('');
      onEnd?.();
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [isSupported, lang, onTranscript, onInterimTranscript, onError, onEnd]);

  const stopListening = useCallback(() => {
    startRequestRef.current += 1;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.stop();
    } else {
      setState('idle');
      setInterimTranscript('');
      onEnd?.();
    }
  }, [onEnd]);

  const resetTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
  }, []);

  return {
    state,
    isSupported,
    transcript,
    interimTranscript,
    startListening,
    stopListening,
    resetTranscript,
  };
}
