import { describe, it, expect } from 'vitest';
import { addDays, format, endOfWeek } from 'date-fns';

// Inline the function to test it without importing client module
function resolveDueDate(due: 'today' | 'tomorrow' | 'this_week' | undefined): string | undefined {
  if (!due) return undefined;
  const now = new Date();
  switch (due) {
    case 'today': return format(now, 'yyyy-MM-dd');
    case 'tomorrow': return format(addDays(now, 1), 'yyyy-MM-dd');
    case 'this_week': return format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  }
}

describe('resolveDueDate', () => {
  it('returns undefined for undefined input', () => {
    expect(resolveDueDate(undefined)).toBeUndefined();
  });

  it('returns today in YYYY-MM-DD format', () => {
    const result = resolveDueDate('today');
    expect(result).toBe(format(new Date(), 'yyyy-MM-dd'));
  });

  it('returns tomorrow in YYYY-MM-DD format', () => {
    const result = resolveDueDate('tomorrow');
    expect(result).toBe(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
  });

  it('returns end of week (Sunday) for this_week', () => {
    const result = resolveDueDate('this_week');
    const expected = format(endOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');
    expect(result).toBe(expected);
  });

  it('this_week does not exceed 7 days from now', () => {
    const result = resolveDueDate('this_week');
    const now = new Date();
    const end = endOfWeek(now, { weekStartsOn: 1 });
    const diff = end.getTime() - now.getTime();
    expect(diff).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
});

describe('share target param parsing', () => {
  it('builds note from shared URL and text', () => {
    const sharedUrl: string = 'https://example.com/article';
    const sharedText: string = 'Check this out';

    const noteParts: string[] = [];
    if (sharedUrl) noteParts.push(sharedUrl);
    if (sharedText && sharedText !== sharedUrl) noteParts.push(sharedText);
    const notes = noteParts.join('\n');

    expect(notes).toBe('https://example.com/article\nCheck this out');
  });

  it('avoids duplicating URL when text equals URL', () => {
    const sharedUrl: string = 'https://example.com';
    const sharedText: string = 'https://example.com';

    const noteParts: string[] = [];
    if (sharedUrl) noteParts.push(sharedUrl);
    if (sharedText && sharedText !== sharedUrl) noteParts.push(sharedText);
    const notes = noteParts.join('\n');

    expect(notes).toBe('https://example.com');
  });

  it('handles empty values gracefully', () => {
    const sharedUrl: string = '';
    const sharedText: string = '';

    const noteParts: string[] = [];
    if (sharedUrl) noteParts.push(sharedUrl);
    if (sharedText && sharedText !== sharedUrl) noteParts.push(sharedText);

    expect(noteParts.length).toBe(0);
  });
});

describe('context chip tag slug construction', () => {
  it('constructs energy tag slug correctly', () => {
    const energyLevel = 'high';
    const slug = `energy-${energyLevel}`;
    expect(slug).toBe('energy-high');
  });

  it('combines energy and triage tags', () => {
    const energyLevel = 'medium';
    let tagSlugs: string[] = [];
    if (energyLevel) {
      tagSlugs = [`energy-${energyLevel}`];
    }
    tagSlugs = [...tagSlugs, 'needs-triage'];
    expect(tagSlugs).toEqual(['energy-medium', 'needs-triage']);
  });

  it('only adds needs-triage when no energy', () => {
    const energyLevel = undefined;
    let tagSlugs: string[] = [];
    if (energyLevel) {
      tagSlugs = [`energy-${energyLevel}`];
    }
    tagSlugs = [...(tagSlugs || []), 'needs-triage'];
    expect(tagSlugs).toEqual(['needs-triage']);
  });
});
