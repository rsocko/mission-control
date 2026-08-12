import { describe, expect, it } from 'vitest';
import {
  beginRuntimeOperation,
  getRuntimeOperationSnapshot,
  normalizeRouteFamily,
} from '@/lib/telemetry/operations';

describe('runtime operation correlation', () => {
  it('normalizes high-cardinality route identifiers', () => {
    expect(normalizeRouteFamily(
      '/api/tasks/01987654-abcd-7890-abcd-123456789abc/history/12345',
    )).toBe('/api/tasks/:id/history/:id');
  });

  it('retains only bounded identity fields while an operation is active', () => {
    const finish = beginRuntimeOperation({
      kind: 'import',
      name: 'twitter archive with spaces',
      traceId: 'trace 123',
      routeFamily: '/api/triage/import/12345',
    });

    expect(getRuntimeOperationSnapshot()).toMatchObject({
      activeExpensive: 1,
      active: [
        expect.objectContaining({
          kind: 'import',
          name: 'twitter_archive_with_spaces',
          traceId: 'trace_123',
          routeFamily: '/api/triage/import/:id',
        }),
      ],
    });
    finish();
    expect(getRuntimeOperationSnapshot().active).toEqual([]);
  });
});
