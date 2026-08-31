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
  });

  it('fails closed for a malformed incoming timestamp but recovers a corrupt stored value', () => {
    expect(isWorkTodoCheckpointAdvance(
      '2026-08-07T20:00:00.0009Z',
      '2026-08-07T20:00:00.not-a-fractionZ',
    )).toBe(false);
    expect(isWorkTodoCheckpointAdvance(
      'not-a-timestamp',
      '2026-08-07T20:00:00.0001Z',
    )).toBe(true);
  });

  it('keeps the ingest contract open to greater-than-millisecond precision', () => {
    const parsed = workTodoIngestSchema.safeParse({
      schemaVersion: '1.0',
      connectorInstanceId: 'work-todo',
      syncTimestamp: '2026-08-07T20:00:00.123456789Z',
      isFullSnapshot: true,
      lists: [],
    });

    expect(parsed.success).toBe(true);
  });
});
