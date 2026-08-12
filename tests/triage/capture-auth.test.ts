import { describe, expect, it, afterEach } from 'vitest';
import { hasValidTriageCaptureKey } from '@/lib/triage/capture-auth';

describe('hasValidTriageCaptureKey', () => {
  const originalEnv = process.env.MC_TRIAGE_CAPTURE_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MC_TRIAGE_CAPTURE_KEY = originalEnv;
    } else {
      delete process.env.MC_TRIAGE_CAPTURE_KEY;
    }
  });

  it('allows any request when no capture key is configured', () => {
    delete process.env.MC_TRIAGE_CAPTURE_KEY;
    const req = new Request('http://localhost/api/triage/capture', { method: 'POST' });
    expect(hasValidTriageCaptureKey(req)).toBe(true);
  });

  it('does not treat a forgeable internal-client marker as authentication', () => {
    process.env.MC_TRIAGE_CAPTURE_KEY = 'test-secret';
    const req = new Request('http://localhost/api/triage/capture', {
      method: 'POST',
      headers: {
        'x-internal-client': 'pwa-share-target',
      },
    });
    expect(hasValidTriageCaptureKey(req)).toBe(false);
  });

  it('rejects requests without any auth when capture key is configured', () => {
    process.env.MC_TRIAGE_CAPTURE_KEY = 'test-secret';
    const req = new Request('http://localhost/api/triage/capture', {
      method: 'POST',
    });
    expect(hasValidTriageCaptureKey(req)).toBe(false);
  });

  it('accepts the correct x-triage-capture-key header', () => {
    process.env.MC_TRIAGE_CAPTURE_KEY = 'test-secret';
    const req = new Request('http://localhost/api/triage/capture', {
      method: 'POST',
      headers: { 'x-triage-capture-key': 'test-secret' },
    });
    expect(hasValidTriageCaptureKey(req)).toBe(true);
  });

  it('accepts the documented x-capture-key compatibility header', () => {
    process.env.MC_TRIAGE_CAPTURE_KEY = 'test-secret';
    const req = new Request('http://localhost/api/triage/capture', {
      method: 'POST',
      headers: { 'x-capture-key': 'test-secret' },
    });
    expect(hasValidTriageCaptureKey(req)).toBe(true);
  });

  it('accepts the correct Bearer token', () => {
    process.env.MC_TRIAGE_CAPTURE_KEY = 'test-secret';
    const req = new Request('http://localhost/api/triage/capture', {
      method: 'POST',
      headers: { 'authorization': 'Bearer test-secret' },
    });
    expect(hasValidTriageCaptureKey(req)).toBe(true);
  });

  it('rejects an incorrect key', () => {
    process.env.MC_TRIAGE_CAPTURE_KEY = 'test-secret';
    const req = new Request('http://localhost/api/triage/capture', {
      method: 'POST',
      headers: { 'x-triage-capture-key': 'wrong-key' },
    });
    expect(hasValidTriageCaptureKey(req)).toBe(false);
  });
});
