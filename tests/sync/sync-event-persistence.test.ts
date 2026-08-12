import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  syncLogger: {
    warn: vi.fn(),
  },
}));

describe('sync event persistence', () => {
  it('does not fail connector work when progress persistence fails', async () => {
    const { setSyncEventPersistence, syncEventBus } = await import('@/lib/sync/events');
    const listener = vi.fn();
    syncEventBus.onSyncEvent(listener);
    setSyncEventPersistence(() => {
      throw new Error('disk full');
    });

    expect(() => syncEventBus.emitSyncEvent({
      type: 'sync:start',
      connectorId: 'github-1',
      connectorName: 'GitHub',
      phase: 'tasks',
    })).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();

    setSyncEventPersistence(null);
    syncEventBus.offSyncEvent(listener);
  });
});
