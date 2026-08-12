import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceCapture } from '@/lib/hooks/useVoiceCapture';

const recognitionStart = vi.fn();

class MockSpeechRecognition {
  lang = '';
  interimResults = false;
  continuous = false;
  maxAlternatives = 1;
  onstart: SpeechRecognition['onstart'] = null;
  onresult: SpeechRecognition['onresult'] = null;
  onerror: SpeechRecognition['onerror'] = null;
  onend: SpeechRecognition['onend'] = null;
  start = recognitionStart;
  stop = vi.fn();
  abort = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn(() => true);
}

function configureBrowser(userAgent: string, standalone: boolean) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: standalone,
      media: '(display-mode: standalone)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
}

describe('useVoiceCapture microphone permission', () => {
  const stopTrack = vi.fn();
  const createStream = () => ({
    getTracks: () => [{ stop: stopTrack }],
  });
  const getUserMedia = vi.fn(async () => createStream());

  beforeEach(() => {
    vi.stubGlobal('SpeechRecognition', MockSpeechRecognition);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('does not pre-acquire the microphone in a non-Edge PWA', async () => {
    configureBrowser(
      'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      true,
    );
    const { result } = renderHook(() => useVoiceCapture());

    await act(async () => result.current.startListening());

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('does not pre-acquire the microphone in a regular Edge tab', async () => {
    configureBrowser(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      false,
    );
    const { result } = renderHook(() => useVoiceCapture());

    await act(async () => result.current.startListening());

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('pre-acquires the microphone only once in an installed Edge PWA', async () => {
    configureBrowser(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      true,
    );
    const { result } = renderHook(() => useVoiceCapture());

    await act(async () => result.current.startListening());
    await act(async () => result.current.startListening());

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight preflight between overlapping starts', async () => {
    configureBrowser(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      true,
    );
    let resolveStream:
      | ((stream: ReturnType<typeof createStream> | PromiseLike<ReturnType<typeof createStream>>) => void)
      | undefined;
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => {
      resolveStream = resolve;
    }));
    const { result } = renderHook(() => useVoiceCapture());

    await act(async () => {
      const firstStart = result.current.startListening();
      const secondStart = result.current.startListening();
      resolveStream?.(createStream());
      await Promise.all([firstStart, secondStart]);
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(recognitionStart).toHaveBeenCalledTimes(1);
  });

  it('does not start recognition when preflight resolves after unmount', async () => {
    configureBrowser(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      true,
    );
    let resolveStream:
      | ((stream: ReturnType<typeof createStream> | PromiseLike<ReturnType<typeof createStream>>) => void)
      | undefined;
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => {
      resolveStream = resolve;
    }));
    const { result, unmount } = renderHook(() => useVoiceCapture());

    const startPromise = result.current.startListening();
    unmount();
    resolveStream?.(createStream());
    await act(async () => startPromise);

    expect(recognitionStart).not.toHaveBeenCalled();
  });

  it.each(['unmount', 'stop'] as const)(
    'does not report a delayed denial after %s',
    async cancelMethod => {
      configureBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
        true,
      );
      let rejectPreflight: ((reason?: unknown) => void) | undefined;
      getUserMedia.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectPreflight = reject;
      }));
      const onError = vi.fn();
      const { result, unmount } = renderHook(() => useVoiceCapture({ onError }));

      const startPromise = result.current.startListening();
      if (cancelMethod === 'unmount') {
        unmount();
      } else {
        result.current.stopListening();
      }
      rejectPreflight?.(new DOMException('Permission denied', 'NotAllowedError'));
      await act(async () => startPromise);

      expect(onError).not.toHaveBeenCalled();
      expect(recognitionStart).not.toHaveBeenCalled();
    },
  );

  it('retries preflight after microphone permission was denied', async () => {
    configureBrowser(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      true,
    );
    getUserMedia.mockRejectedValueOnce(new DOMException(
      'Permission denied',
      'NotAllowedError',
    ));
    const { result } = renderHook(() => useVoiceCapture());

    await act(async () => result.current.startListening());
    expect(result.current.state).toBe('denied');

    await act(async () => result.current.startListening());

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(recognitionStart).toHaveBeenCalledTimes(1);
  });
});
