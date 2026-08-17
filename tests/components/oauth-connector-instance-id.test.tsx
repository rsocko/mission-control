import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createOAuthConnectorInstanceId,
  useOAuthConnectorInstanceId,
} from '@/app/settings/components/useOAuthConnectorInstanceId';

describe('OAuth connector instance IDs', () => {
  it('supports deterministic UUID injection', () => {
    expect(createOAuthConnectorInstanceId(
      'mstodo',
      () => '11111111-1111-4111-8111-111111111111',
    )).toBe('mstodo-11111111-1111-4111-8111-111111111111');
  });

  it('generates once per creation and remains stable across rerenders', () => {
    const randomUuid = vi.fn(() => '22222222-2222-4222-8222-222222222222');
    const { result, rerender } = renderHook(() => (
      useOAuthConnectorInstanceId('outlook-email', randomUuid)
    ));

    const firstRead = result.current();
    rerender();

    expect(result.current()).toBe(firstRead);
    expect(firstRead).toBe('outlook-email-22222222-2222-4222-8222-222222222222');
    expect(randomUuid).toHaveBeenCalledOnce();
  });

  it('uses a fresh UUID for a new creation instance', () => {
    const randomUuid = vi.fn()
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333')
      .mockReturnValueOnce('44444444-4444-4444-8444-444444444444');
    const first = renderHook(() => useOAuthConnectorInstanceId('mstodo', randomUuid));
    const firstId = first.result.current();
    first.unmount();
    const second = renderHook(() => useOAuthConnectorInstanceId('mstodo', randomUuid));

    expect(firstId).not.toBe(second.result.current());
    expect(randomUuid).toHaveBeenCalledTimes(2);
  });
});
