import { describe, expect, it, vi } from 'vitest';
import { createPostgresRuntimeTelemetryPersistence } from '@/db/postgres/telemetry-runtime';

describe('PostgreSQL runtime telemetry persistence', () => {
  it('preserves the legacy 10,000-row cap for hours-based history reads', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const persistence = createPostgresRuntimeTelemetryPersistence({
      query,
    } as never);

    await persistence.getHistory({
      role: 'web',
      since: '2026-09-04T00:00:00.000Z',
    });

    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('LIMIT $3'),
      values: ['2026-09-04T00:00:00.000Z', 'web', 10_000],
    }));
  });
});
