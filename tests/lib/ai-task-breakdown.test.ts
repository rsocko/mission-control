import { describe, expect, it } from 'vitest';
import {
  buildBreakdownPrompt,
  normalizeBreakdownProposals,
  titleKey,
} from '@/lib/ai/task-breakdown';

describe('AI task breakdown normalization', () => {
  it('strictly rejects malformed and empty model output', () => {
    expect(normalizeBreakdownProposals({ subtasks: [] }, [])).toEqual([]);
    expect(normalizeBreakdownProposals({
      subtasks: [{ title: 'Valid title', unexpected: true }],
    }, [])).toEqual([]);
  });

  it('normalizes whitespace and removes existing or repeated titles', () => {
    let id = 0;
    const result = normalizeBreakdownProposals({
      subtasks: [
        { title: '  Write   integration tests ', description: ' Cover errors. ', effort: 2 },
        { title: 'WRITE integration tests!', description: '', effort: 3 },
        { title: 'Update docs', description: '', effort: 1 },
        { title: 'Ship release', description: '', effort: null },
      ],
    }, ['Update docs'], () => `proposal-${++id}`);

    expect(result).toEqual([
      {
        id: 'proposal-1',
        title: 'Write integration tests',
        description: 'Cover errors.',
        effort: 2,
      },
      {
        id: 'proposal-2',
        title: 'Ship release',
        description: '',
        effort: null,
      },
    ]);
    expect(titleKey('WRITE integration tests!')).toBe(titleKey('write integration tests'));
  });

  it('bounds prompt context supplied to the model', () => {
    const prompt = buildBreakdownPrompt({
      title: 'Task',
      description: 'x'.repeat(4000),
      priority: 'high',
      dueDate: null,
      effort: 5,
      sourceListName: 'List',
      tags: Array.from({ length: 30 }, (_, index) => `tag-${index}`),
      projects: Array.from({ length: 20 }, (_, index) => `project-${index}`),
      existingSubtasks: Array.from({ length: 40 }, (_, index) => `subtask-${index}`),
    });

    expect(prompt).not.toContain('tag-20');
    expect(prompt).not.toContain('project-10');
    expect(prompt).not.toContain('subtask-30');
  });
});
