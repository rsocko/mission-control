import { describe, expect, it, vi } from 'vitest';
import { waitForWebReadiness } from '@/lib/runtime/web-readiness';

describe('worker web readiness gate', () => {
  it('does nothing when no readiness URL is configured', async () => {
    const fetchResponse = vi.fn();

    await waitForWebReadiness({ url: '', fetchResponse });

    expect(fetchResponse).not.toHaveBeenCalled();
  });

  it('waits until web readiness succeeds', async () => {
    const fetchResponse = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await waitForWebReadiness({
      url: 'http://mission-control:3099/api/health/ready',
      maxAttempts: 3,
      retryIntervalMs: 10,
      fetchResponse,
      sleep,
      onRetry,
    });

    expect(fetchResponse).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('fails after the configured attempt bound', async () => {
    const fetchResponse = vi.fn().mockResolvedValue({ ok: false });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(waitForWebReadiness({
      url: 'http://mission-control:3099/api/health/ready',
      maxAttempts: 2,
      fetchResponse,
      sleep,
    })).rejects.toThrow('Web readiness did not succeed after 2 attempts');

    expect(fetchResponse).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
});
