import { describe, expect, it } from 'vitest';
import { isMicroStatusSyncEnabled } from '@/lib/micro-status';

describe('isMicroStatusSyncEnabled', () => {
  it('preserves enabled sync for legacy connectors without the setting', () => {
    expect(isMicroStatusSyncEnabled({})).toBe(true);
  });

  it('only enables outbound sync when explicitly selected', () => {
    expect(isMicroStatusSyncEnabled({ syncMicroStatus: true })).toBe(true);
    expect(isMicroStatusSyncEnabled({ syncMicroStatus: false })).toBe(false);
  });
});
