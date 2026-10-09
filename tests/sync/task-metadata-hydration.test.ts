import { describe, expect, it } from 'vitest';
import {
  needsDocumentCreatedAtHydration,
  needsMicrosoftTodoLinkedResourceHydration,
} from '@/lib/sync/task-metadata-hydration';

describe('Microsoft To Do linked-resource hydration', () => {
  it('hydrates existing personal tasks when a full sync first supplies linked resources', () => {
    expect(needsMicrosoftTodoLinkedResourceHydration(
      'microsoft-todo',
      { graphId: 'task-1' },
      { graphId: 'task-1', linkedResources: [] },
    )).toBe(true);
  });

  it('does not repeatedly update hydrated tasks or affect other connectors', () => {
    expect(needsMicrosoftTodoLinkedResourceHydration(
      'microsoft-todo',
      { graphId: 'task-1', linkedResources: [] },
      { graphId: 'task-1', linkedResources: [] },
    )).toBe(false);
    expect(needsMicrosoftTodoLinkedResourceHydration(
      'github-issues',
      {},
      { linkedResources: [] },
    )).toBe(false);
  });

  it('replaces an empty expanded collection when the dedicated endpoint recovers a link', () => {
    expect(needsMicrosoftTodoLinkedResourceHydration(
      'microsoft-todo',
      { graphId: 'task-1', linkedResources: [] },
      {
        graphId: 'task-1',
        linkedResources: [{
          id: 'email-link',
          applicationName: 'Microsoft Outlook',
          displayName: 'Flagged email',
          webUrl: 'https://outlook.office.com/mail/deeplink/read/id',
        }],
      },
    )).toBe(true);
  });
});

describe('document creation date hydration', () => {
  it('hydrates existing document tasks when OWL first supplies the Paperless date', () => {
    expect(needsDocumentCreatedAtHydration(
      'document-intelligence',
      { owlCreatedAt: '2026-10-09T00:42:33Z' },
      {
        owlCreatedAt: '2026-10-09T00:42:33Z',
        documentCreatedAt: '2026-09-24',
      },
    )).toBe(true);
  });

  it('does not repeatedly update hydrated tasks or affect other connectors', () => {
    expect(needsDocumentCreatedAtHydration(
      'document-intelligence',
      { documentCreatedAt: '2026-09-24' },
      { documentCreatedAt: '2026-09-24' },
    )).toBe(false);
    expect(needsDocumentCreatedAtHydration(
      'github-issues',
      {},
      { documentCreatedAt: '2026-09-24' },
    )).toBe(false);
  });
});
