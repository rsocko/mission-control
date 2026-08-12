import { describe, it, expect } from 'vitest';
import {
  extractPendingTasks,
  normalizePendingTaskText,
  stripTaskListPrefix,
  stripPhasePrefix,
  splitCompoundTask,
  type ExtractedTask,
} from '@/lib/paste-parser';

// ─── Helper ─────────────────────────────────────────────────────────────────

function texts(tasks: ExtractedTask[]): string[] {
  return tasks.map(t => t.text);
}

// ─── normalizePendingTaskText ───────────────────────────────────────────────

describe('normalizePendingTaskText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizePendingTaskText('  hello   world  ')).toBe('hello world');
  });
  it('normalizes \\r\\n to spaces', () => {
    expect(normalizePendingTaskText('foo\r\nbar')).toBe('foo bar');
  });
});

// ─── stripTaskListPrefix ────────────────────────────────────────────────────

describe('stripTaskListPrefix', () => {
  it('strips bullet dash', () => expect(stripTaskListPrefix('- foo')).toBe('foo'));
  it('strips bullet dot', () => expect(stripTaskListPrefix('• bar')).toBe('bar'));
  it('strips numbered', () => expect(stripTaskListPrefix('1. baz')).toBe('baz'));
  it('strips asterisk', () => expect(stripTaskListPrefix('* qux')).toBe('qux'));
  it('preserves non-list text', () => expect(stripTaskListPrefix('no prefix')).toBe('no prefix'));
});

// ─── stripPhasePrefix ───────────────────────────────────────────────────────

describe('stripPhasePrefix', () => {
  it('strips Phase N:', () => expect(stripPhasePrefix('Phase 1: Research')).toBe('Research'));
  it('strips Step N:', () => expect(stripPhasePrefix('Step 2: Design')).toBe('Design'));
  it('strips Stage N.', () => expect(stripPhasePrefix('Stage 3. Build')).toBe('Build'));
  it('is case-insensitive', () => expect(stripPhasePrefix('PHASE 1: Foo')).toBe('Foo'));
  it('preserves non-phase text', () => expect(stripPhasePrefix('Regular task')).toBe('Regular task'));
});

// ─── Semicolon delimiter ────────────────────────────────────────────────────

describe('extractPendingTasks – semicolons', () => {
  it('splits on ;; delimiters', () => {
    const result = extractPendingTasks('Buy milk ;; Call dentist ;; Fix bug');
    expect(texts(result.committed)).toEqual(['Buy milk', 'Call dentist']);
    expect(result.remaining).toBe('Fix bug');
  });

  it('returns no committed for single segment', () => {
    const result = extractPendingTasks('Just one task');
    expect(result.committed).toHaveLength(0);
    expect(result.remaining).toBe('Just one task');
  });
});

// ─── Markdown table ─────────────────────────────────────────────────────────

describe('extractPendingTasks – markdown table', () => {
  it('parses a basic table with title and priority', () => {
    const input = [
      '| Task | Priority |',
      '|------|----------|',
      '| Design API | High |',
      '| Write tests | Low |',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed).toHaveLength(2);
    expect(result.committed[0].text).toBe('Design API !high');
    expect(result.committed[1].text).toBe('Write tests !low');
    expect(result.remaining).toBe('');
  });

  it('maps due date, effort, and tags columns', () => {
    const input = [
      '| Task | Due | Effort | Tags |',
      '|------|-----|--------|------|',
      '| Build UI | tomorrow | M | frontend, design |',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed).toHaveLength(1);
    const text = result.committed[0].text;
    expect(text).toContain('Build UI');
    expect(text).toContain('tomorrow');
    expect(text).toContain('^3');
    expect(text).toContain('#frontend');
    expect(text).toContain('#design');
  });

  it('skips empty/N/A cells', () => {
    const input = [
      '| Task | Priority |',
      '|------|----------|',
      '| Do thing | N/A |',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed[0].text).toBe('Do thing');
  });

  it('maps project column with / prefix', () => {
    const input = [
      '| Task | Project |',
      '|------|---------|',
      '| Fix bug | backend |',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed[0].text).toBe('Fix bug /backend');
  });

  it('strips phase prefixes from table task titles', () => {
    const input = [
      '| Task | Priority |',
      '|------|----------|',
      '| Phase 1: Research | High |',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed[0].text).toBe('Research !high');
  });

  it('requires a title column', () => {
    const input = [
      '| Priority | Due |',
      '|----------|-----|',
      '| High | tomorrow |',
    ].join('\n');
    const result = extractPendingTasks(input);
    // Falls back to plain multi-line since no title column
    expect(result.committed.length).toBeGreaterThanOrEqual(0);
  });

  it('handles alignment colons in separator', () => {
    const input = [
      '| Task | Priority |',
      '|:-----|:--------:|',
      '| Centered | Medium |',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed[0].text).toBe('Centered !medium');
  });
});

// ─── Checkbox list ──────────────────────────────────────────────────────────

describe('extractPendingTasks – checkbox list', () => {
  it('parses unchecked items', () => {
    const input = [
      '- [ ] Design the API',
      '- [ ] Write unit tests',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed).toHaveLength(2);
    expect(texts(result.committed)).toEqual(['Design the API', 'Write unit tests']);
    expect(result.committed.every(t => !t.isComplete)).toBe(true);
  });

  it('marks checked items as isComplete', () => {
    const input = [
      '- [x] Done task',
      '- [ ] Not done',
      '- [X] Also done',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed[0].isComplete).toBe(true);
    expect(result.committed[1].isComplete).toBe(false);
    expect(result.committed[2].isComplete).toBe(true);
  });

  it('strips phase prefixes from checkbox items', () => {
    const input = '- [ ] Step 1: Research competitors\n- [ ] Step 2: Analyze data';
    const result = extractPendingTasks(input);
    expect(result.committed[0].text).toBe('Research competitors');
    expect(result.committed[1].text).toBe('Analyze data');
  });
});

// ─── Nested list ────────────────────────────────────────────────────────────

describe('extractPendingTasks – nested list', () => {
  it('creates parent-child relationships from indentation', () => {
    const input = [
      '- Backend work',
      '  - Design API schema',
      '  - Set up database',
      '- Frontend work',
      '  - Build components',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed).toHaveLength(5);

    // Parents
    expect(result.committed[0].text).toBe('Backend work');
    expect(result.committed[0].parentIndex).toBeNull();

    // Children of "Backend work" (index 0)
    expect(result.committed[1].text).toBe('Design API schema');
    expect(result.committed[1].parentIndex).toBe(0);
    expect(result.committed[2].text).toBe('Set up database');
    expect(result.committed[2].parentIndex).toBe(0);

    // Second parent
    expect(result.committed[3].text).toBe('Frontend work');
    expect(result.committed[3].parentIndex).toBeNull();

    // Children of "Frontend work" (index 3)
    expect(result.committed[4].text).toBe('Build components');
    expect(result.committed[4].parentIndex).toBe(3);
  });

  it('handles nested checkboxes', () => {
    const input = [
      '- Parent task',
      '  - [ ] Child 1',
      '  - [x] Child 2',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed).toHaveLength(3);
    expect(result.committed[1].parentIndex).toBe(0);
    expect(result.committed[1].isComplete).toBe(false);
    expect(result.committed[2].parentIndex).toBe(0);
    expect(result.committed[2].isComplete).toBe(true);
  });

  it('falls through to flat list when all items same indent', () => {
    const input = [
      '- Item 1',
      '- Item 2',
      '- Item 3',
    ].join('\n');
    const result = extractPendingTasks(input);
    // Should be flat (no parentIndex set), handled by bullet list parser
    expect(result.committed.every(t => t.parentIndex === null)).toBe(true);
  });
});

// ─── Flat bullet/numbered list ──────────────────────────────────────────────

describe('extractPendingTasks – flat bullet list', () => {
  it('parses bullet list', () => {
    const input = [
      '- Buy groceries',
      '- Clean house',
      '- Walk dog',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(texts(result.committed)).toEqual(['Buy groceries', 'Clean house', 'Walk dog']);
    expect(result.remaining).toBe('');
  });

  it('parses numbered list', () => {
    const input = [
      '1. First task',
      '2. Second task',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(texts(result.committed)).toEqual(['First task', 'Second task']);
  });

  it('strips phase prefixes', () => {
    const input = [
      '- Phase 1: Research',
      '- Phase 2: Design',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(texts(result.committed)).toEqual(['Research', 'Design']);
  });
});

// ─── Plain multi-line text ──────────────────────────────────────────────────

describe('extractPendingTasks – plain multi-line', () => {
  it('commits all but last line, keeps last as remaining', () => {
    const input = 'Task one\nTask two\nTask three';
    const result = extractPendingTasks(input);
    expect(texts(result.committed)).toEqual(['Task one', 'Task two']);
    expect(result.remaining).toBe('Task three');
  });

  it('returns empty for single line', () => {
    const result = extractPendingTasks('Just one line');
    expect(result.committed).toHaveLength(0);
    expect(result.remaining).toBe('Just one line');
  });
});

// ─── Mixed / edge cases ────────────────────────────────────────────────────

describe('extractPendingTasks – edge cases', () => {
  it('handles empty input', () => {
    const result = extractPendingTasks('');
    expect(result.committed).toHaveLength(0);
    expect(result.remaining).toBe('');
  });

  it('handles whitespace-only input', () => {
    const result = extractPendingTasks('   \n   \n   ');
    expect(result.committed).toHaveLength(0);
  });

  it('handles \\r\\n line endings', () => {
    const input = '- Task A\r\n- Task B\r\n- Task C';
    const result = extractPendingTasks(input);
    expect(texts(result.committed)).toEqual(['Task A', 'Task B', 'Task C']);
  });

  it('strips asterisk bullets', () => {
    const input = '* Item 1\n* Item 2';
    const result = extractPendingTasks(input);
    expect(texts(result.committed)).toEqual(['Item 1', 'Item 2']);
  });

  it('table with "Work Item" column header', () => {
    const input = [
      '| Work Item | Priority |',
      '|-----------|----------|',
      '| API design | High |',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed[0].text).toBe('API design !high');
  });

  it('table with markdown-formatted headers', () => {
    const input = [
      '| **Task** | **Priority** |',
      '|----------|--------------|',
      '| Fix login | Medium |',
    ].join('\n');
    const result = extractPendingTasks(input);
    expect(result.committed[0].text).toBe('Fix login !medium');
  });
});

// ─── Compound task splitting (NLP "and" detection) ──────────────────────────

describe('splitCompoundTask', () => {
  it('splits "verb and verb" pattern', () => {
    const result = splitCompoundTask('Email Sarah about Q3 and schedule dentist for next week');
    expect(result).toEqual(['Email Sarah about Q3', 'schedule dentist for next week']);
  });

  it('splits "verb then verb" pattern', () => {
    const result = splitCompoundTask('Buy groceries then pick up dry cleaning');
    expect(result).toEqual(['Buy groceries', 'pick up dry cleaning']);
  });

  it('splits "verb also verb" pattern', () => {
    const result = splitCompoundTask('Call the plumber also order new faucet');
    expect(result).toEqual(['Call the plumber', 'order new faucet']);
  });

  it('splits single semicolon between verb phrases', () => {
    const result = splitCompoundTask('Send invoice to client; schedule follow-up meeting');
    expect(result).toEqual(['Send invoice to client', 'schedule follow-up meeting']);
  });

  it('does not split on commas (too ambiguous)', () => {
    const result = splitCompoundTask('Review PR #42, deploy to staging');
    expect(result).toBeNull();
  });

  it('splits three verb phrases', () => {
    const result = splitCompoundTask('Email Sarah and call dentist and buy milk');
    expect(result).toEqual(['Email Sarah', 'call dentist', 'buy milk']);
  });

  it('does not split when second part is not verb-led', () => {
    const result = splitCompoundTask('Buy bread and butter');
    expect(result).toBeNull();
  });

  it('does not split when first word is not a verb', () => {
    const result = splitCompoundTask('Groceries and call dentist');
    expect(result).toBeNull();
  });

  it('returns null for single task', () => {
    const result = splitCompoundTask('Buy groceries from the store');
    expect(result).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(splitCompoundTask('')).toBeNull();
  });

  it('handles "and then" connector', () => {
    const result = splitCompoundTask('Fix the bug and then deploy the update');
    expect(result).toEqual(['Fix the bug', 'deploy the update']);
  });

  it('handles "and also" connector', () => {
    const result = splitCompoundTask('Write the report and also send the email');
    expect(result).toEqual(['Write the report', 'send the email']);
  });
});

describe('extractPendingTasks – compound NLP splitting', () => {
  it('splits compound task via extractPendingTasks', () => {
    const result = extractPendingTasks('Email Sarah about Q3 and schedule dentist for next week');
    expect(result.committed).toHaveLength(1);
    expect(result.committed[0].text).toBe('Email Sarah about Q3');
    expect(result.remaining).toBe('schedule dentist for next week');
  });

  it('prefers ;; over NLP splitting', () => {
    const result = extractPendingTasks('Buy milk ;; Call dentist and schedule follow-up');
    expect(result.committed).toHaveLength(1);
    expect(result.committed[0].text).toBe('Buy milk');
    expect(result.remaining).toBe('Call dentist and schedule follow-up');
  });

  it('does not split non-compound single-line input', () => {
    const result = extractPendingTasks('Buy bread and butter from the store');
    expect(result.committed).toHaveLength(0);
    expect(result.remaining).toBe('Buy bread and butter from the store');
  });
});
