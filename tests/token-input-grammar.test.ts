import { describe, expect, it } from 'vitest';
import { findTokens } from '@/components/add-task/TokenInput';

describe('Quick Add token highlighting', () => {
  it('highlights only natural-language dates that submission will apply', () => {
    const middle = findTokens('Call tomorrow about the invoice', {
      naturalLanguageDates: true,
    });
    const trailing = findTokens('Call the client tomorrow !high', {
      naturalLanguageDates: true,
    });

    expect(middle.some(({ type }) => type === 'date')).toBe(false);
    expect(trailing.some(({ type }) => type === 'date')).toBe(true);
  });

  it('highlights explicit due dates wherever the command appears', () => {
    const tokens = findTokens('Call the client /due:next friday', {
      naturalLanguageDates: true,
    });
    expect(tokens.some(({ type }) => type === 'date')).toBe(true);
  });

  it.each([
    ['!0', 'priority-critical'],
    ['!1', 'priority-high'],
    ['!2', 'priority-medium'],
    ['!3', 'priority-low'],
  ] as const)('highlights numeric priority %s', (input, type) => {
    expect(findTokens(`Task ${input}`, { naturalLanguageDates: true }))
      .toContainEqual(expect.objectContaining({ type }));
  });

  it('highlights the full known multi-word project token', () => {
    const input = 'Ship homepage +Website Redesign';
    const tokens = findTokens(input, {
      naturalLanguageDates: true,
      projects: [{ id: 'project-web', name: 'Website Redesign' }],
    });
    const project = tokens.find(({ type }) => type === 'project');

    expect(input.slice(project?.start, project?.end)).toBe('+Website Redesign');
  });

  it('does not highlight metadata disabled for subtask entry', () => {
    const tokens = findTokens('Child #ops daily ^3', {
      naturalLanguageDates: true,
      metadata: {
        tags: false,
        recurrence: false,
      },
    });
    expect(tokens.some(({ type }) => type === 'tag')).toBe(false);
    expect(tokens.some(({ type }) => type === 'effort')).toBe(true);
  });
});
