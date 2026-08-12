/**
 * Tests for the cross-source field mapping engine.
 * Covers: computeFieldMappings, priorityToGitHubLabel, isGitHubNativeTransfer, buildCrossReferenceNote
 */
import { describe, it, expect } from 'vitest';
import {
  computeFieldMappings,
  priorityToGitHubLabel,
  isGitHubNativeTransfer,
  buildCrossReferenceNote,
} from '@/lib/connectors/field-mapper';

// ─── priorityToGitHubLabel ────────────────────────────────────────────────────

describe('priorityToGitHubLabel', () => {
  it('maps critical to priority:critical', () => {
    expect(priorityToGitHubLabel('critical')).toBe('priority:critical');
  });

  it('maps high to priority:high', () => {
    expect(priorityToGitHubLabel('high')).toBe('priority:high');
  });

  it('maps medium to priority:medium', () => {
    expect(priorityToGitHubLabel('medium')).toBe('priority:medium');
  });

  it('maps low to priority:low', () => {
    expect(priorityToGitHubLabel('low')).toBe('priority:low');
  });

  it('maps unknown values to null', () => {
    expect(priorityToGitHubLabel('urgent')).toBeNull();
    expect(priorityToGitHubLabel('')).toBeNull();
  });
});

// ─── isGitHubNativeTransfer ──────────────────────────────────────────────────

describe('isGitHubNativeTransfer', () => {
  it('returns true for same-owner GitHub→GitHub', () => {
    expect(isGitHubNativeTransfer('github-issues', 'github-issues', 'acme/repo-a', 'acme/repo-b')).toBe(true);
  });

  it('returns false for different-owner GitHub→GitHub', () => {
    expect(isGitHubNativeTransfer('github-issues', 'github-issues', 'acme/repo-a', 'other-org/repo-b')).toBe(false);
  });

  it('returns false for GitHub→Microsoft Todo', () => {
    expect(isGitHubNativeTransfer('github-issues', 'microsoft-todo', 'acme/repo-a', 'list-id')).toBe(false);
  });

  it('returns false for Microsoft Todo→GitHub', () => {
    expect(isGitHubNativeTransfer('microsoft-todo', 'github-issues', 'list-id', 'acme/repo-a')).toBe(false);
  });

  it('returns false for non-github types', () => {
    expect(isGitHubNativeTransfer('microsoft-todo', 'microsoft-todo', 'list-a', 'list-b')).toBe(false);
  });

  it('returns false when sourceListId has no owner part', () => {
    expect(isGitHubNativeTransfer('github-issues', 'github-issues', '', 'acme/repo')).toBe(false);
  });
});

// ─── buildCrossReferenceNote ─────────────────────────────────────────────────

describe('buildCrossReferenceNote', () => {
  it('builds a source direction note', () => {
    const note = buildCrossReferenceNote('source', 'github-issues', 'acme/repo-b', 'Fix login');
    expect(note).toContain('linked copy');
    expect(note).toContain('GitHub Issues');
    expect(note).toContain('acme/repo-b');
  });

  it('builds a target direction note', () => {
    const note = buildCrossReferenceNote('target', 'microsoft-todo', 'My List', 'Fix login');
    expect(note).toContain('copied from');
    expect(note).toContain('Microsoft To Do');
    expect(note).toContain('My List');
    expect(note).toContain('Fix login');
  });

  it('handles unknown connector types gracefully', () => {
    const note = buildCrossReferenceNote('source', 'unknown-type', 'some-list', 'Task');
    expect(note).toContain('unknown-type');
  });
});

// ─── computeFieldMappings ────────────────────────────────────────────────────

describe('computeFieldMappings', () => {
  const baseTask = {
    title: 'Test Task',
    description: 'A description',
    priority: 'high',
    dueDate: '2026-08-01',
    tags: [{ name: 'bug' }, { name: 'urgent' }],
    assignee: 'user@example.com',
    status: 'todo',
    effort: 3,
  };

  describe('title mapping', () => {
    it('always maps title 1:1', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask);
      const titleMapping = result.fieldMappings.find(m => m.field === 'title');
      expect(titleMapping).toBeDefined();
      expect(titleMapping!.status).toBe('mapped');
      expect(titleMapping!.sourceValue).toBe('Test Task');
      expect(titleMapping!.targetValue).toBe('Test Task');
    });
  });

  describe('description mapping', () => {
    it('preserves description content when moving MS Todo→GitHub', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask);
      const descMapping = result.fieldMappings.find(m => m.field === 'description');
      expect(descMapping!.status).toBe('mapped');
      expect(descMapping!.sourceValue).toBe(baseTask.description);
      expect(descMapping!.warning).toContain('verbatim');
    });

    it('preserves description content when moving GitHub→MS Todo', () => {
      const result = computeFieldMappings('github-issues', 'microsoft-todo', baseTask);
      const descMapping = result.fieldMappings.find(m => m.field === 'description');
      expect(descMapping!.status).toBe('mapped');
    });

    it('maps directly for same-type connectors', () => {
      const result = computeFieldMappings('microsoft-todo', 'microsoft-todo', baseTask);
      const descMapping = result.fieldMappings.find(m => m.field === 'description');
      expect(descMapping!.status).toBe('mapped');
    });

    it('omits description mapping when no description', () => {
      const task = { ...baseTask, description: null };
      const result = computeFieldMappings('microsoft-todo', 'github-issues', task);
      const descMapping = result.fieldMappings.find(m => m.field === 'description');
      expect(descMapping).toBeUndefined();
    });
  });

  describe('status mapping', () => {
    it('shows how non-default status is preserved', () => {
      const result = computeFieldMappings('local', 'github-issues', {
        ...baseTask,
        status: 'in_progress',
      });
      const statusMapping = result.fieldMappings.find(m => m.field === 'status');
      expect(statusMapping).toEqual(expect.objectContaining({
        status: 'converted',
        targetValue: 'open',
      }));
    });
  });

  describe('priority mapping', () => {
    it('maps priority 1:1 when target supports it (MS Todo→MS Todo)', () => {
      const result = computeFieldMappings('microsoft-todo', 'microsoft-todo', baseTask);
      const priMapping = result.fieldMappings.find(m => m.field === 'priority');
      expect(priMapping!.status).toBe('mapped');
    });

    it('converts priority to a reversible GitHub label', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask);
      const priMapping = result.fieldMappings.find(m => m.field === 'priority');
      expect(priMapping!.status).toBe('converted');
      expect(priMapping!.targetValue).toContain('priority:high');
    });

    it('maps low priority→GitHub via priority:low label', () => {
      const task = { ...baseTask, priority: 'low' };
      const result = computeFieldMappings('microsoft-todo', 'github-issues', task);
      const priMapping = result.fieldMappings.find(m => m.field === 'priority');
      expect(priMapping!.status).toBe('converted');
      expect(priMapping!.targetValue).toContain('priority:low');
    });

    it('omits priority mapping when priority is none', () => {
      const task = { ...baseTask, priority: 'none' };
      const result = computeFieldMappings('microsoft-todo', 'github-issues', task);
      const priMapping = result.fieldMappings.find(m => m.field === 'priority');
      expect(priMapping).toBeUndefined();
    });
  });

  describe('due date mapping', () => {
    it('maps dueDate when target supports it (MS Todo→MS Todo)', () => {
      const result = computeFieldMappings('microsoft-todo', 'microsoft-todo', baseTask);
      const dueMapping = result.fieldMappings.find(m => m.field === 'dueDate');
      expect(dueMapping!.status).toBe('mapped');
    });

    it('keeps dueDate in MC when target is GitHub', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask);
      const dueMapping = result.fieldMappings.find(m => m.field === 'dueDate');
      expect(dueMapping!.status).toBe('converted');
      expect(dueMapping!.warning).toContain('kept in Mission Control');
      expect(dueMapping!.warning).toContain('github-issues');
    });

    it('omits dueDate mapping when no dueDate', () => {
      const task = { ...baseTask, dueDate: null };
      const result = computeFieldMappings('microsoft-todo', 'github-issues', task);
      const dueMapping = result.fieldMappings.find(m => m.field === 'dueDate');
      expect(dueMapping).toBeUndefined();
    });
  });

  describe('tags mapping', () => {
    it('preserves tags locally and writes them remotely where supported', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask);
      const tagMapping = result.fieldMappings.find(m => m.field === 'tags');
      expect(tagMapping!.status).toBe('converted');
      expect(tagMapping!.warning).toContain('preserved in Mission Control');
    });

    it('maps tags without warning for non-GitHub target', () => {
      const result = computeFieldMappings('github-issues', 'microsoft-todo', baseTask);
      const tagMapping = result.fieldMappings.find(m => m.field === 'tags');
      expect(tagMapping!.status).toBe('converted');
    });

    it('omits tags mapping when no tags', () => {
      const task = { ...baseTask, tags: [] };
      const result = computeFieldMappings('microsoft-todo', 'github-issues', task);
      const tagMapping = result.fieldMappings.find(m => m.field === 'tags');
      expect(tagMapping).toBeUndefined();
    });
  });

  describe('assignee mapping', () => {
    it('preserves assignee locally when remote identity is uncertain', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask);
      const assigneeMapping = result.fieldMappings.find(m => m.field === 'assignee');
      expect(assigneeMapping!.status).toBe('converted');
      expect(assigneeMapping!.warning).toContain('identity');
    });

    it('omits assignee when not set', () => {
      const task = { ...baseTask, assignee: null };
      const result = computeFieldMappings('microsoft-todo', 'github-issues', task);
      const assigneeMapping = result.fieldMappings.find(m => m.field === 'assignee');
      expect(assigneeMapping).toBeUndefined();
    });
  });

  describe('effort mapping', () => {
    it('converts effort to a canonical GitHub label', () => {
      const result = computeFieldMappings('local', 'github-issues', baseTask);
      const effortMapping = result.fieldMappings.find(m => m.field === 'effort');
      expect(effortMapping!.status).toBe('converted');
      expect(effortMapping!.targetValue).toBe('label: effort:3');
    });

    it('keeps effort in Mission Control when the target has no native mapping', () => {
      const result = computeFieldMappings('github-issues', 'microsoft-todo', baseTask);
      const effortMapping = result.fieldMappings.find(m => m.field === 'effort');
      expect(effortMapping!.targetValue).toBe('(kept in Mission Control)');
    });
  });

  describe('attachment mapping', () => {
    it('preserves attachments locally when the target cannot upload them', () => {
      const result = computeFieldMappings('local', 'github-issues', baseTask, 0, 2, false);
      const attachmentMapping = result.fieldMappings.find(m => m.field === 'attachments');
      expect(attachmentMapping).toEqual(expect.objectContaining({
        status: 'converted',
        targetValue: '(kept in Mission Control)',
      }));
      expect(result.hasLossyFields).toBe(false);
    });
  });

  describe('subtask handling', () => {
    it('returns null subtask info when no subtasks', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask, 0);
      expect(result.subtasks).toBeNull();
    });

    it('suggests move-as-subtasks for GitHub→GitHub (rich subtasks)', () => {
      const result = computeFieldMappings('github-issues', 'github-issues', baseTask, 3);
      expect(result.subtasks!.strategy).toBe('move-as-subtasks');
      expect(result.subtasks!.count).toBe(3);
    });

    it('preserves rich GitHub sub-issues as Microsoft To Do steps and notes', () => {
      const result = computeFieldMappings('github-issues', 'microsoft-todo', baseTask, 2);
      expect(result.subtasks!.strategy).toBe('preserve-details-and-steps');
      expect(result.subtasks!.warning).toContain('Microsoft To Do steps');
      expect(result.subtasks!.warning).toContain('task notes');
    });

    it('warns when MS Todo checklist→GitHub sub-issues (only title+state)', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask, 4);
      expect(result.subtasks!.strategy).toBe('move-as-subtasks');
      expect(result.subtasks!.warning).toContain('checklist item');
    });

    it('suggests flatten-to-checklist when target has no subtask support', () => {
      // Using a connector type not in CONNECTORS_WITH_SUBTASKS
      const result = computeFieldMappings('microsoft-todo', 'outlook-email', baseTask, 2);
      expect(result.subtasks!.strategy).toBe('flatten-to-checklist');
      expect(result.subtasks!.warning).toContain('embedded');
    });
  });

  describe('hasLossyFields', () => {
    it('is false when fields are converted without data loss', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask);
      expect(result.hasLossyFields).toBe(false);
    });

    it('is false when subtasks are preserved with a warning', () => {
      const task = { ...baseTask, priority: 'none', dueDate: null, assignee: null };
      const result = computeFieldMappings('microsoft-todo', 'github-issues', task, 2);
      expect(result.hasLossyFields).toBe(false);
    });

    it('is false when all fields map cleanly and no subtasks', () => {
      const task = { title: 'Test', description: 'desc', priority: 'high', dueDate: '2026-01-01', tags: [], assignee: null, status: 'todo' };
      const result = computeFieldMappings('microsoft-todo', 'microsoft-todo', task, 0);
      expect(result.hasLossyFields).toBe(false);
    });
  });

  describe('sourceSupportsDelete', () => {
    it('is true for local tasks', () => {
      const result = computeFieldMappings('local', 'github-issues', baseTask);
      expect(result.sourceSupportsDelete).toBe(true);
    });

    it('is true for microsoft-todo', () => {
      const result = computeFieldMappings('microsoft-todo', 'github-issues', baseTask);
      expect(result.sourceSupportsDelete).toBe(true);
    });

    it('is false for github-issues', () => {
      const result = computeFieldMappings('github-issues', 'microsoft-todo', baseTask);
      expect(result.sourceSupportsDelete).toBe(false);
    });
  });
});
