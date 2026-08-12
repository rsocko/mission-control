/**
 * Tests for escape mechanism in Quick Add parser (issue #849)
 * Users can prefix token-triggering characters with \ to prevent detection.
 */
import { describe, it, expect } from 'vitest';
import { parseTaskInput } from '@/lib/parse-task-input';

describe('parseTaskInput – backslash escape', () => {
  describe('escaped tags', () => {
    it('does not extract \\#tag as a tag', () => {
      const result = parseTaskInput('buy \\#electronics');
      expect(result.tags).toHaveLength(0);
    });

    it('strips the backslash from the title when tag is escaped', () => {
      const result = parseTaskInput('buy \\#electronics');
      expect(result.title).toBe('buy #electronics');
    });

    it('still extracts unescaped tags when mixed with escaped ones', () => {
      const result = parseTaskInput('buy \\#electronics #shopping');
      expect(result.tags).toEqual(['shopping']);
      expect(result.title).toBe('buy #electronics');
    });

    it('handles multiple escaped tags', () => {
      const result = parseTaskInput('learn about \\#typescript and \\#react');
      expect(result.tags).toHaveLength(0);
      expect(result.title).toBe('learn about #typescript and #react');
    });
  });

  describe('escaped priority', () => {
    it('does not extract \\!high as a priority', () => {
      const result = parseTaskInput('use \\!high contrast theme');
      expect(result.priority).toBeNull();
    });

    it('strips the backslash from the title when priority is escaped', () => {
      const result = parseTaskInput('use \\!high contrast theme');
      expect(result.title).toBe('use !high contrast theme');
    });
  });

  describe('escaped destination', () => {
    it('does not extract \\@work as a destination', () => {
      const result = parseTaskInput('email \\@work address');
      expect(result.destination).toBeNull();
    });

    it('strips the backslash from the title when destination is escaped', () => {
      const result = parseTaskInput('email \\@work address');
      expect(result.title).toBe('email @work address');
    });
  });

  describe('escaped duration', () => {
    it('does not extract \\~30m as a duration', () => {
      const result = parseTaskInput('read \\~30m of content');
      expect(result.estimatedDuration).toBeNull();
    });

    it('strips the backslash from the title when duration is escaped', () => {
      const result = parseTaskInput('read \\~30m of content');
      expect(result.title).toBe('read ~30m of content');
    });
  });

  describe('escaped effort', () => {
    it('does not extract \\^3 as an effort level', () => {
      const result = parseTaskInput('score \\^3 points');
      expect(result.effort).toBeNull();
    });

    it('strips the backslash from the title when effort is escaped', () => {
      const result = parseTaskInput('score \\^3 points');
      expect(result.title).toBe('score ^3 points');
    });
  });

  describe('escaped date words', () => {
    it('does not extract \\friday as a due date', () => {
      const result = parseTaskInput('meeting on \\friday at 3pm');
      expect(result.dueDate).toBeNull();
    });

    it('strips the backslash from the title when date word is escaped', () => {
      const result = parseTaskInput('meeting on \\friday at 3pm');
      expect(result.title).toBe('meeting on friday at 3pm');
    });

    it('does not extract \\tomorrow as a due date', () => {
      const result = parseTaskInput('read \\tomorrow never dies');
      expect(result.dueDate).toBeNull();
    });

    it('strips every escape marker from multiple NLP date tokens', () => {
      const result = parseTaskInput('compare \\aug 15 with \\sep 20');
      expect(result.dueDate).toBeNull();
      expect(result.dateSuggestion).toBeNull();
      expect(result.title).toBe('compare aug 15 with sep 20');
    });

    it('strips escape markers from every escaped token in one title', () => {
      const result = parseTaskInput(
        'literal \\#tag \\@work \\!high \\~30m \\^3 \\+API \\/due:tomorrow \\next friday \\aug 15',
      );
      expect(result.tags).toHaveLength(0);
      expect(result.destination).toBeNull();
      expect(result.priority).toBeNull();
      expect(result.estimatedDuration).toBeNull();
      expect(result.effort).toBeNull();
      expect(result.project).toBeNull();
      expect(result.dueDate).toBeNull();
      expect(result.dateSuggestion).toBeNull();
      expect(result.title).toBe(
        'literal #tag @work !high ~30m ^3 +API /due:tomorrow next friday aug 15',
      );
    });

    it.each([
      ['review \\next friday', 'review next friday'],
      ['review \\in 3 days', 'review in 3 days'],
      ['review \\end \\of \\month', 'review end of month'],
    ])('does not suggest an escaped trailing date in %s', (input, title) => {
      const result = parseTaskInput(input);
      expect(result.dateSuggestion).toBeNull();
      expect(result.title).toBe(title);
    });

    it('preserves a literal backslash that is not an escape marker', () => {
      const result = parseTaskInput('back up C:\\aug data');
      expect(result.title).toBe('back up C:\\aug data');
    });
  });

  describe('escaped and active copies of the same token', () => {
    it('removes the active priority without persisting the escape marker', () => {
      const result = parseTaskInput('compare \\!high with !high');
      expect(result.priority).toBe('high');
      expect(result.title).toBe('compare !high with');
    });

    it('removes the active destination without persisting the escape marker', () => {
      const result = parseTaskInput('email \\@work before filing @work');
      expect(result.destination).toBe('work');
      expect(result.title).toBe('email @work before filing');
    });

    it('removes the active duration without persisting the escape marker', () => {
      const result = parseTaskInput('compare \\~30m with ~30m');
      expect(result.estimatedDuration).toBe(30);
      expect(result.title).toBe('compare ~30m with');
    });

    it('removes the active effort without persisting the escape marker', () => {
      const result = parseTaskInput('compare \\^3 with ^3');
      expect(result.effort).toBe(3);
      expect(result.title).toBe('compare ^3 with');
    });

    it('removes the active project without persisting the escape marker', () => {
      const result = parseTaskInput('compare \\+API with +API', {
        projects: [{ id: 'project-api', name: 'API' }],
      });
      expect(result.projectId).toBe('project-api');
      expect(result.title).toBe('compare +API with');
    });

    it('removes the active due command without persisting the escape marker', () => {
      const result = parseTaskInput('compare \\/due:tomorrow with /due:tomorrow');
      expect(result.dueDate).not.toBeNull();
      expect(result.title).toBe('compare /due:tomorrow with');
    });
  });

  describe('unescaped tokens still work', () => {
    it('extracts normal tags without backslash', () => {
      const result = parseTaskInput('buy groceries #shopping');
      expect(result.tags).toEqual(['shopping']);
      expect(result.title).toBe('buy groceries');
    });

    it('extracts normal priority without backslash', () => {
      const result = parseTaskInput('fix bug !high');
      expect(result.priority).toBe('high');
      expect(result.title).toBe('fix bug');
    });

    it('suggests a normal trailing date without backslash', () => {
      const result = parseTaskInput('submit report friday');
      expect(result.dateSuggestion).not.toBeNull();
      expect(result.title).toBe('submit report friday');
    });
  });

  describe('tags with special characters (issue #1031)', () => {
    it('extracts tags containing colons (namespaced)', () => {
      const result = parseTaskInput('fix layout #area:projects');
      expect(result.tags).toEqual(['area:projects']);
      expect(result.title).toBe('fix layout');
    });

    it('extracts tags containing dots', () => {
      const result = parseTaskInput('upgrade to #v2.0');
      expect(result.tags).toEqual(['v2.0']);
      expect(result.title).toBe('upgrade to');
    });

    it('extracts tags with multiple colons', () => {
      const result = parseTaskInput('task #scope:area:sub');
      expect(result.tags).toEqual(['scope:area:sub']);
      expect(result.title).toBe('task');
    });

    it('extracts tags containing slashes', () => {
      const result = parseTaskInput('review #frontend/css');
      expect(result.tags).toEqual(['frontend/css']);
      expect(result.title).toBe('review');
    });

    it('extracts multiple namespaced tags', () => {
      const result = parseTaskInput('work on #area:projects #priority:high');
      expect(result.tags).toEqual(['area:projects', 'priority:high']);
      expect(result.title).toBe('work on');
    });

    it('mixes namespaced and plain tags', () => {
      const result = parseTaskInput('deploy #area:infra #urgent');
      expect(result.tags).toEqual(['area:infra', 'urgent']);
      expect(result.title).toBe('deploy');
    });
  });
});
