import { describe, expect, it } from 'vitest';
import { getPublicDemoRestriction, isPublicDemoValue } from '@/lib/public-demo';

describe('public demo policy', () => {
  it('requires an explicit true environment value', () => {
    expect(isPublicDemoValue('true')).toBe(true);
    expect(isPublicDemoValue('false')).toBe(false);
    expect(isPublicDemoValue(undefined)).toBe(false);
  });

  it('allows safe demo reads and local interactions', () => {
    expect(getPublicDemoRestriction('/api/tasks', 'GET')).toBeNull();
    expect(getPublicDemoRestriction('/api/tasks/task-1', 'PATCH')).toBeNull();
    expect(getPublicDemoRestriction('/api/tasks/task-1/subtasks', 'POST')).toBeNull();
    expect(getPublicDemoRestriction('/api/tasks/move/preview', 'POST')).toBeNull();
    expect(getPublicDemoRestriction('/api/my-day', 'POST')).toBeNull();
    expect(getPublicDemoRestriction('/api/triage/item-1', 'PATCH')).toBeNull();
    expect(getPublicDemoRestriction('/api/connectors', 'GET')).toBeNull();
    expect(getPublicDemoRestriction('/api/tasks/task-1/attachments', 'GET')).toBeNull();
    expect(getPublicDemoRestriction('/api/scout/reconciliation/suggestions', 'GET')).toBeNull();
    expect(getPublicDemoRestriction('/api/health/live', 'GET')).toBeNull();
    expect(getPublicDemoRestriction('/api/sync/health', 'GET')).toBeNull();
    expect(getPublicDemoRestriction('/api/health/ready', 'GET')).toBeNull();
  });

  it('blocks credentials, integrations, synchronization, and outbound operations', () => {
    expect(getPublicDemoRestriction('/api/settings/mode', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/connectors/github-1/test', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/triage/import/github-stars', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/tasks/move/execute', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/ai', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/push/subscribe', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/goals/develop', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/notifications/triage', 'GET')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/project-phases/ai-suggest', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/resets/ai-summary', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/tasks/task-1/attachments', 'POST')).not.toBeNull();
    expect(getPublicDemoRestriction('/api/scout/reconciliation/suggestions/scout-1', 'PATCH')).not.toBeNull();
  });
});
