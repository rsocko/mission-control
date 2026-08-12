import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/db', () => ({ default: {} }));

describe('connector capability defaults', () => {
  it('preserves tag scope for connector records created before the field existed', async () => {
    const { CAPABILITY_DEFAULTS } = await import('@/lib/connectors/capabilities');

    expect(CAPABILITY_DEFAULTS['github-issues']?.tagScope).toBe('per-list');
    expect(CAPABILITY_DEFAULTS['microsoft-todo']?.tagScope).toBe('global');
  });
});
