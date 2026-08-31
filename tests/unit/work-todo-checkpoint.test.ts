import { describe, expect, it } from 'vitest';
import { isWorkTodoCheckpointAdvance } from '@/db/persistence/work-todo';
import { workTodoIngestSchema } from '@/lib/connectors/work-todo/contracts';

describe('Work To Do checkpoint ordering', () => {
  it('orders arbitrary RFC3339 fractional precision without truncation', () => {
    expect(isWorkTodoCheckpointAdvance(
      '2026-08-07T20:00:00.0009Z',
      '2026-08-07T20:00:00.0001Z',
    )).toBe(false);
    expect(isWorkTodoCheckpointAdvance(
      '2026-08-07T20:00:00.0001Z',
      '2026-08-07T20:00:00.0009Z',
    )).toBe(true);
    expect(isWorkTodoCheckpointAdvance(
      '2026-08-07T20:00:00.12345678901234567890Z',
      '2026-08-07T20:00:00.12345678901234567891Z',
    )).toBe(true);
  });

  it('treats offset and fractional representations of one instant as equal', () => {
    expect(isWorkTodoCheckpointAdvance(
      '2026-08-07T20:00:00.1Z',
      '2026-08-07T16:00:00.100000000-04:00',
    )).toBe(true);
    expect(isWorkTodoCheckpointAdvance(
      '2026-08-07T20:00Z',
      '2026-08-07T16:00:00.000000000-04:00',
    )).toBe(true);
  });

  it('fails closed for malformed incoming and stored timestamps', () => {
    expect(isWorkTodoCheckpointAdvance(
      '2026-08-07T20:00:00.0009Z',
      '2026-08-07T20:00:00.not-a-fractionZ',
    )).toBe(false);
    expect(isWorkTodoCheckpointAdvance(
      'not-a-timestamp',
      '2026-08-07T20:00:00.0001Z',
    )).toBe(false);
    expect(isWorkTodoCheckpointAdvance(
      null,
      'not-a-timestamp',
    )).toBe(false);
  });

  it('orders every timestamp precision accepted by the ingest contract', () => {
    for (const syncTimestamp of [
      '2026-08-07T20:00Z',
      '2026-08-07T20:00:00Z',
      '2026-08-07T20:00:00.123456789Z',
      '2026-08-07T16:00-04:00',
    ]) {
      const parsed = workTodoIngestSchema.safeParse({
        schemaVersion: '1.0',
        connectorInstanceId: 'work-todo',
        syncTimestamp,
        isFullSnapshot: true,
        lists: [],
      });

      expect(parsed.success).toBe(true);
      expect(isWorkTodoCheckpointAdvance(null, syncTimestamp)).toBe(true);
    }
  });
});
