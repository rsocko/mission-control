import { describe, expect, it } from 'vitest';
import { extractRecurrenceFromMetadata } from '@/lib/utils/recurrence';

describe('extractRecurrenceFromMetadata', () => {
  it('reads recurrence from an already-parsed metadata object', () => {
    // API responses deliver metadata as a parsed object (Drizzle's `mode: 'json'`
    // auto-parses the JSON column), which is the shape connector-synced tasks
    // (e.g. Microsoft To Do) always arrive in.
    expect(extractRecurrenceFromMetadata({ recurrence: 'daily' })).toBe('daily');
  });

  it('reads recurrence from a raw JSON metadata string', () => {
    expect(extractRecurrenceFromMetadata(JSON.stringify({ recurrence: 'weekly' }))).toBe('weekly');
  });

  it('returns null for an object without a recurrence field', () => {
    expect(extractRecurrenceFromMetadata({ graphId: 'abc' })).toBeNull();
  });

  it('returns null for malformed JSON strings', () => {
    expect(extractRecurrenceFromMetadata('not json')).toBeNull();
  });

  it('returns null for absent metadata', () => {
    expect(extractRecurrenceFromMetadata(null)).toBeNull();
    expect(extractRecurrenceFromMetadata(undefined)).toBeNull();
  });

  it('returns null when recurrence is not a string', () => {
    expect(extractRecurrenceFromMetadata({ recurrence: null })).toBeNull();
    expect(extractRecurrenceFromMetadata({ recurrence: 123 })).toBeNull();
  });
});
