import { describe, it, expect } from 'vitest';
import { parseTaskInput, parseRecurrence } from '@/lib/parse-task-input';

describe('parseRecurrence', () => {
  it('parses "daily"', () => {
    const r = parseRecurrence('do this daily');
    expect(r).not.toBeNull();
    expect(r!.result.value).toBe('daily');
    expect(r!.result.label).toBe('Daily');
  });

  it('parses "every day"', () => {
    const r = parseRecurrence('water plants every day');
    expect(r!.result.value).toBe('daily');
  });

  it('parses "weekdays"', () => {
    const r = parseRecurrence('standup weekdays');
    expect(r!.result.value).toBe('weekdays');
    expect(r!.result.label).toBe('Weekdays (Mon\u2013Fri)');
  });

  it('parses "every weekday"', () => {
    const r = parseRecurrence('check email every weekday');
    expect(r!.result.value).toBe('weekdays');
  });

  it('parses "weekly"', () => {
    const r = parseRecurrence('review code weekly');
    expect(r!.result.value).toBe('weekly');
    expect(r!.result.label).toBe('Weekly');
  });

  it('parses "every week"', () => {
    const r = parseRecurrence('sync up every week');
    expect(r!.result.value).toBe('weekly');
  });

  it('parses "biweekly"', () => {
    const r = parseRecurrence('sprint review biweekly');
    expect(r!.result.value).toBe('biweekly');
    expect(r!.result.label).toBe('Every 2 weeks');
  });

  it('parses "every other week"', () => {
    const r = parseRecurrence('dentist every other week');
    expect(r!.result.value).toBe('biweekly');
  });

  it('parses "monthly"', () => {
    const r = parseRecurrence('pay rent monthly');
    expect(r!.result.value).toBe('monthly');
    expect(r!.result.label).toBe('Monthly');
  });

  it('parses "every month"', () => {
    const r = parseRecurrence('bill review every month');
    expect(r!.result.value).toBe('monthly');
  });

  it('parses "yearly"', () => {
    const r = parseRecurrence('renew license yearly');
    expect(r!.result.value).toBe('yearly');
  });

  it('parses "annually"', () => {
    const r = parseRecurrence('tax filing annually');
    expect(r!.result.value).toBe('yearly');
  });

  it('parses "every 3 days"', () => {
    const r = parseRecurrence('water cactus every 3 days');
    expect(r!.result.value).toBe('every 3 days');
    expect(r!.result.label).toBe('Every 3 days');
  });

  it('parses "every 1 day" as daily', () => {
    const r = parseRecurrence('check in every 1 day');
    expect(r!.result.value).toBe('daily');
    expect(r!.result.label).toBe('Daily');
  });

  it('parses "every 2 weeks" as biweekly', () => {
    const r = parseRecurrence('retro every 2 weeks');
    expect(r!.result.value).toBe('biweekly');
  });

  it('parses "every 6 months"', () => {
    const r = parseRecurrence('dentist every 6 months');
    expect(r!.result.value).toBe('every 6 months');
    expect(r!.result.label).toBe('Every 6 months');
  });

  it('parses "every mon,wed,fri"', () => {
    const r = parseRecurrence('gym every mon,wed,fri');
    expect(r).not.toBeNull();
    expect(r!.result.value).toBe('weekly (monday, wednesday, friday)');
    expect(r!.result.label).toBe('Weekly on Mon, Wed, Fri');
  });

  it('parses "every monday and friday"', () => {
    const r = parseRecurrence('standup every monday and friday');
    expect(r).not.toBeNull();
    expect(r!.result.value).toContain('monday');
    expect(r!.result.value).toContain('friday');
  });

  it('parses "every monday" as single-day weekly', () => {
    const r = parseRecurrence('standup every monday');
    expect(r).not.toBeNull();
    expect(r!.result.value).toBe('weekly (monday)');
    expect(r!.result.label).toBe('Weekly on Mon');
  });

  it('rejects "every 0 days"', () => {
    const r = parseRecurrence('something every 0 days');
    expect(r).toBeNull();
  });

  it('returns null for non-recurrence text', () => {
    const r = parseRecurrence('buy groceries tomorrow');
    expect(r).toBeNull();
  });
});

describe('parseTaskInput recurrence integration', () => {
  it('extracts recurrence from task text and cleans title', () => {
    const result = parseTaskInput('water plants every day');
    expect(result.recurrence).toBe('daily');
    expect(result.recurrenceLabel).toBe('Daily');
    expect(result.title).toBe('water plants');
  });

  it('handles recurrence with other tokens', () => {
    const result = parseTaskInput('standup weekly !high #work ~15m');
    expect(result.recurrence).toBe('weekly');
    expect(result.priority).toBe('high');
    expect(result.tags).toContain('work');
    expect(result.estimatedDuration).toBe(15);
    expect(result.title).toBe('standup');
  });

  it('handles custom interval recurrence', () => {
    const result = parseTaskInput('water cactus every 3 days');
    expect(result.recurrence).toBe('every 3 days');
    expect(result.title).toBe('water cactus');
  });

  it('returns null recurrence when none present', () => {
    const result = parseTaskInput('buy groceries tomorrow');
    expect(result.recurrence).toBeNull();
    expect(result.recurrenceLabel).toBeNull();
  });

  it('handles day list recurrence', () => {
    const result = parseTaskInput('gym every mon,wed,fri ~1h');
    expect(result.recurrence).toBe('weekly (monday, wednesday, friday)');
    expect(result.estimatedDuration).toBe(60);
    expect(result.title).toBe('gym');
  });

  it('strips recurrence from title case-insensitively', () => {
    const result = parseTaskInput('Water plants Daily');
    expect(result.recurrence).toBe('daily');
    expect(result.title).toBe('Water plants');
  });

  it('handles mixed-case "Every 3 Days"', () => {
    const result = parseTaskInput('Feed fish Every 3 Days');
    expect(result.recurrence).toBe('every 3 days');
    expect(result.title).toBe('Feed fish');
  });

  it('handles single day: "every monday"', () => {
    const result = parseTaskInput('standup every monday');
    expect(result.recurrence).toBe('weekly (monday)');
    expect(result.recurrenceLabel).toBe('Weekly on Mon');
    expect(result.title).toBe('standup');
  });

  it('rejects "every 0 days"', () => {
    const result = parseTaskInput('something every 0 days');
    expect(result.recurrence).toBeNull();
  });
});
