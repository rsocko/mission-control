import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTaskInput } from '@/lib/parse-task-input';
import { extractPendingTasks } from '@/lib/paste-parser';

const FIXED_NOW = new Date('2026-09-17T12:00:00');
const projects = [{ id: 'project-web', name: 'Website Redesign' }];

describe('Quick Add token grammar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses the supported task metadata tokens together', () => {
    const result = parseTaskInput(
      'Ship homepage #creative +Website Redesign /due:next friday !high *',
      { projects },
    );

    expect(result).toMatchObject({
      title: 'Ship homepage',
      tags: ['creative'],
      project: 'Website Redesign',
      projectId: 'project-web',
      dueDate: '2026-09-25',
      priority: 'high',
      addToMyDay: true,
    });
  });

  it.each([
    ['Plan today *', 'Plan today'],
    ['* Plan today', 'Plan today'],
    ['Plan * today', 'Plan today'],
  ])('treats a standalone asterisk as My Day in "%s"', (input, title) => {
    const result = parseTaskInput(input);
    expect(result.addToMyDay).toBe(true);
    expect(result.title).toBe(title);
  });

  it('does not treat embedded asterisks as My Day markers', () => {
    const result = parseTaskInput('Call *555*1234');
    expect(result.addToMyDay).toBe(false);
    expect(result.title).toBe('Call *555*1234');
  });

  it('requires a named priority instead of accepting bare exclamation marks', () => {
    const result = parseTaskInput('Important task !');
    expect(result.priority).toBeNull();
    expect(result.title).toBe('Important task !');
  });

  it('keeps retired @ destination syntax as ordinary title text', () => {
    const result = parseTaskInput('File issue @github and email @work');
    expect(result.title).toBe('File issue @github and email @work');
  });

  it('keeps trailing dates suggestion-only until explicitly accepted', () => {
    const suggested = parseTaskInput('Buy a gift next Saturday');
    const explicit = parseTaskInput('Buy a gift /due:next Saturday');

    expect(suggested.dueDate).toBeNull();
    expect(suggested.dateSuggestion?.date).toBe('2026-09-26');
    expect(suggested.title).toBe('Buy a gift next Saturday');
    expect(explicit.dueDate).toBe('2026-09-26');
    expect(explicit.title).toBe('Buy a gift');
  });

  it('disables trailing NLP date suggestions without affecting explicit /due commands', () => {
    const suggested = parseTaskInput('Buy a gift next Saturday', {
      naturalLanguageDates: false,
    });
    const explicit = parseTaskInput('Buy a gift /due:next Saturday', {
      naturalLanguageDates: false,
    });

    expect(suggested.dateSuggestion).toBeNull();
    expect(suggested.title).toBe('Buy a gift next Saturday');
    expect(explicit.dueDate).toBe('2026-09-26');
  });

  it('extracts newline-separated Quick Add input as separate tasks', () => {
    const result = extractPendingTasks('Plan today *\nPlan later');

    expect(result.committed.map(({ text }) => text)).toEqual(['Plan today *']);
    expect(result.remaining).toBe('Plan later');
    expect(parseTaskInput(result.committed[0].text).addToMyDay).toBe(true);
    expect(parseTaskInput(result.remaining).addToMyDay).toBe(false);
  });

  it('preserves all supported tokens when preserveText is enabled', () => {
    const input = 'Ship homepage #creative +Website Redesign /due:tomorrow !high *';
    const result = parseTaskInput(input, { projects, preserveText: true });

    expect(result.title).toBe(input);
    expect(result.addToMyDay).toBe(true);
  });
});
