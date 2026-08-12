import { describe, expect, it } from 'vitest';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';

describe('parseTaskMetadataCompat', () => {
  it('returns ordinary metadata objects unchanged', () => {
    expect(parseTaskMetadataCompat('{"recurrence":"weekly","mcOwned":{"pinned":true}}')).toEqual({
      metadata: {
        recurrence: 'weekly',
        mcOwned: { pinned: true },
      },
      recoveredLegacy: false,
    });
  });

  it('recovers double-encoded legacy metadata objects', () => {
    expect(parseTaskMetadataCompat(JSON.stringify('{"recurrence":"daily"}'))).toEqual({
      metadata: { recurrence: 'daily' },
      recoveredLegacy: false,
    });
  });

  it('preserves malformed legacy metadata without treating it as structured data', () => {
    expect(parseTaskMetadataCompat('not-json')).toEqual({
      metadata: { legacyMetadata: 'not-json' },
      recoveredLegacy: true,
    });
  });

  it('wraps legacy primitive values', () => {
    expect(parseTaskMetadataCompat('42')).toEqual({
      metadata: { legacyMetadata: 42 },
      recoveredLegacy: true,
    });
  });
});
