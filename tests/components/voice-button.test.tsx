import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceButton } from '@/components/capture/VoiceButton';
import type { VoiceCaptureState } from '@/lib/hooks/useVoiceCapture';

const voiceCapture = vi.hoisted(() => ({
  state: 'idle' as VoiceCaptureState,
  transcript: '',
  interimTranscript: '',
  startListening: vi.fn(),
  stopListening: vi.fn(),
}));

vi.mock('@/lib/hooks/useVoiceCapture', () => ({
  useVoiceCapture: () => ({
    state: voiceCapture.state,
    isSupported: true,
    transcript: voiceCapture.transcript,
    interimTranscript: voiceCapture.interimTranscript,
    startListening: voiceCapture.startListening,
    stopListening: voiceCapture.stopListening,
  }),
}));

describe('VoiceButton', () => {
  beforeEach(() => {
    voiceCapture.state = 'idle';
    voiceCapture.transcript = '';
    voiceCapture.interimTranscript = '';
    vi.clearAllMocks();
  });

  it('starts voice capture from the idle control', () => {
    render(<VoiceButton onTranscript={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));

    expect(voiceCapture.startListening).toHaveBeenCalledOnce();
  });

  it('shows immediate feedback while the microphone starts', () => {
    voiceCapture.state = 'starting';
    render(<VoiceButton onTranscript={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Preparing microphone');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Approve microphone access if your browser asks.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    expect(voiceCapture.stopListening).toHaveBeenCalledOnce();
  });

  it('makes listening and live transcription explicit', () => {
    voiceCapture.state = 'listening';
    voiceCapture.transcript = 'Book the venue';
    voiceCapture.interimTranscript = 'for Friday';
    render(<VoiceButton onTranscript={vi.fn()} />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Listening now');
    expect(status).toHaveTextContent('Book the venue for Friday');
    expect(status).toHaveTextContent('Live transcription');

    fireEvent.click(screen.getByRole('button', { name: 'Stop voice input' }));
    expect(voiceCapture.stopListening).toHaveBeenCalledOnce();
  });
});
