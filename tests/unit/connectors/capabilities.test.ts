import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCapabilities } from '@/types';

vi.mock('server-only', () => ({}));
vi.mock('@/db', () => ({ default: {} }));

describe('connector capability defaults', () => {
  it('preserves tag scope for connector records created before the field existed', async () => {
    const { CAPABILITY_DEFAULTS } = await import('@/lib/connectors/capabilities');

    expect(CAPABILITY_DEFAULTS['github-issues']?.tagScope).toBe('per-list');
    expect(CAPABILITY_DEFAULTS['microsoft-todo']?.tagScope).toBe('global');
  });

  it('upgrades legacy Microsoft To Do records to hashtag write-back', async () => {
    const { resolvePersistedConnectorCapabilities } = await import(
      '@/lib/connectors/resolved-capabilities'
    );
    const capabilities = resolvePersistedConnectorCapabilities({
      type: 'microsoft-todo',
      capabilities: {
        read: true,
        write: true,
        delete: true,
        sync: true,
        subtasks: true,
        lists: true,
        tags: false,
        tagWriteBack: false,
      } as ConnectorCapabilities,
      settings: {},
    });

    expect(capabilities.tags).toBe(true);
    expect(capabilities.tagWriteBack).toBe(true);
    expect(capabilities.taskFieldProfile?.tags).toEqual({
      authority: 'source',
      writeBack: 'direct',
    });
  });
});
