/**
 * Tests for NLP date parsing (chrono-node integration) — issue #1042
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseNLPDate, parseNLPDateString, findAllNLPDates } from '@/lib/date-parser';
import { parseTaskInput, parseTaskInputForSubmission, parseDateFromText } from '@/lib/parse-task-input';

// Pin "today" to a known Wednesday so weekday tests are deterministic
const FIXED_NOW = new Date('2026-07-15T12:00:00'); // Wednesday

describe('parseNLPDate', () => {
  it('parses "tomorrow"', () => {
    const r = parseNLPDate('tomorrow', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-07-16');
    expect(r!.label).toBe('Tomorrow');
  });

  it('parses "today"', () => {
    const r = parseNLPDate('today', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-07-15');
    expect(r!.label).toBe('Today');
  });

  it('parses "next friday"', () => {
    const r = parseNLPDate('next friday', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-07-24');
    expect(r!.matchedText.toLowerCase()).toContain('friday');
  });

  it('parses "in 3 days"', () => {
    const r = parseNLPDate('in 3 days', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-07-18');
  });

  it('parses "in 2 weeks"', () => {
    const r = parseNLPDate('in 2 weeks', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-07-29');
  });

  it('parses "aug 15"', () => {
    const r = parseNLPDate('aug 15', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-08-15');
  });

  it('parses "end of month"', () => {
    const r = parseNLPDate('end of month', FIXED_NOW);
    expect(r).not.toBeNull();
    // July has 31 days
    expect(r!.date).toBe('2026-07-31');
  });

  it('returns null for non-date text', () => {
    const r = parseNLPDate('buy groceries', FIXED_NOW);
    expect(r).toBeNull();
  });

  it('parses "december 25"', () => {
    const r = parseNLPDate('december 25', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-12-25');
  });

  it('parses "jan 1 2027"', () => {
    const r = parseNLPDate('jan 1 2027', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2027-01-01');
  });
});

describe('parseNLPDateString', () => {
  it('parses a date string and returns date + label', () => {
    const r = parseNLPDateString('next monday', FIXED_NOW);
    expect(r).not.toBeNull();
    expect(r!.date).toBe('2026-07-20');
  });

  it('returns null for invalid input', () => {
    const r = parseNLPDateString('foobar', FIXED_NOW);
    expect(r).toBeNull();
  });
});

describe('findAllNLPDates', () => {
  it('finds multiple dates in text', () => {
    const results = findAllNLPDates('meeting tomorrow and report friday', FIXED_NOW);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns index and matchedText for each match', () => {
    const results = findAllNLPDates('due tomorrow', FIXED_NOW);
    expect(results.length).toBe(1);
    expect(results[0].matchedText.toLowerCase()).toBe('tomorrow');
    expect(results[0].index).toBe(4);
  });
});

describe('parseTaskInput – chrono-node integration', () => {
  // We need to use a fixed date for determinism. Since parseTaskInput uses
  // new Date() internally, we mock it.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suggests a trailing "tomorrow" without applying it', () => {
    const r = parseTaskInput('buy milk tomorrow');
    expect(r.dueDate).toBeNull();
    expect(r.dateSuggestion).toEqual({
      date: '2026-07-16',
      label: 'Tomorrow',
      matchedText: 'tomorrow',
    });
    expect(r.title).toBe('buy milk tomorrow');
  });

  it('suggests a trailing "next friday"', () => {
    const r = parseTaskInput('submit report next friday');
    expect(r.dateSuggestion?.date).toBe('2026-07-24');
    expect(r.title).toBe('submit report next friday');
  });

  it.each([
    ['buy milk today', '2026-07-15', 'buy milk'],
    ['buy milk tomorrow', '2026-07-16', 'buy milk'],
    ['submit report next friday', '2026-07-24', 'submit report'],
    ['plan party aug 15', '2026-08-15', 'plan party'],
  ])('applies a trailing date when submitting "%s"', (input, dueDate, title) => {
    const r = parseTaskInputForSubmission(input);
    expect(r.dueDate).toBe(dueDate);
    expect(r.title).toBe(title);
    expect(r.dateSuggestion).toBeNull();
  });

  it('applies a trailing date after other parsed tokens are removed', () => {
    const r = parseTaskInputForSubmission('fix bug today !high #urgent');
    expect(r.dueDate).toBe('2026-07-15');
    expect(r.priority).toBe('high');
    expect(r.tags).toEqual(['urgent']);
    expect(r.title).toBe('fix bug');
  });

  it('keeps a trailing date in the submitted title when token preservation is enabled', () => {
    const r = parseTaskInputForSubmission('buy milk today', { preserveText: true });
    expect(r.dueDate).toBe('2026-07-15');
    expect(r.title).toBe('buy milk today');
  });

  it('retains date-only input as the title', () => {
    const r = parseTaskInputForSubmission('today');
    expect(r.dueDate).toBe('2026-07-15');
    expect(r.title).toBe('today');
  });

  it('does not apply trailing dates when natural-language dates are disabled', () => {
    const r = parseTaskInputForSubmission('buy milk today', { naturalLanguageDates: false });
    expect(r.dueDate).toBeNull();
    expect(r.title).toBe('buy milk today');
  });

  it('applies an explicit /due: command', () => {
    const r = parseTaskInput('plan party /due:aug 15');
    expect(r.dueDate).toBe('2026-08-15');
    expect(r.title).toBe('plan party');
  });

  it('does not consume title text after an explicit date phrase', () => {
    const r = parseTaskInput('plan party /due:aug 15 with friends');
    expect(r.dueDate).toBe('2026-08-15');
    expect(r.title).toBe('plan party with friends');
  });

  it('cleans an explicit date command with whitespace after the colon', () => {
    const r = parseTaskInput('plan party /due: aug 15');
    expect(r.dueDate).toBe('2026-08-15');
    expect(r.title).toBe('plan party');
  });

  it('retains an explicit date-only command as the title', () => {
    const r = parseTaskInput('/due:today');
    expect(r.dueDate).toBe('2026-07-15');
    expect(r.title).toBe('/due:today');
  });

  it('can disable natural-language date suggestions', () => {
    const r = parseTaskInput('plan party aug 15');
    const disabled = parseTaskInput('plan party aug 15', { naturalLanguageDates: false });
    expect(r.dateSuggestion?.date).toBe('2026-08-15');
    expect(disabled.dateSuggestion).toBeNull();
    expect(disabled.title).toBe('plan party aug 15');
  });

  it('does not extract escaped date words', () => {
    const r = parseTaskInput('meeting on \\friday at 3pm');
    expect(r.dueDate).toBeNull();
    expect(r.title).toBe('meeting on friday at 3pm');
  });

  it('extracts date alongside other tokens', () => {
    const r = parseTaskInput('fix bug /due:tomorrow !high #urgent');
    expect(r.dueDate).toBe('2026-07-16');
    expect(r.priority).toBe('high');
    expect(r.tags).toEqual(['urgent']);
    expect(r.title).toBe('fix bug');
  });

  it('preserves tokens in the title when requested', () => {
    const r = parseTaskInput('review PR /due:in 3 days !high #review', { preserveText: true });
    expect(r.dueDate).toBe('2026-07-18');
    expect(r.priority).toBe('high');
    expect(r.tags).toEqual(['review']);
    expect(r.title).toBe('review PR /due:in 3 days !high #review');
  });
});

describe('parseDateFromText – chrono-node integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('extracts date from free-form text', () => {
    const r = parseDateFromText('This needs to be done by next friday');
    expect(r).not.toBeNull();
    expect(r!.dueDate).toBe('2026-07-24');
  });

  it('extracts "aug 15" from triage text', () => {
    const r = parseDateFromText('Conference deadline is aug 15');
    expect(r).not.toBeNull();
    expect(r!.dueDate).toBe('2026-08-15');
  });

  it('returns null for text with no dates', () => {
    const r = parseDateFromText('Just a random thought about coding');
    expect(r).toBeNull();
  });
});
