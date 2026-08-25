import { describe, expect, it } from 'vitest';
import {
  countDocumentViews,
  filterDocumentTasks,
  groupDocumentTasks,
  parseDocumentTaskMetadata,
  sortDocumentTasks,
  type DocumentTask,
} from '@/app/doc-intelligence/document-workspace';

const NOW = new Date('2026-08-21T12:00:00-04:00');

function task(
  id: string,
  metadata: Record<string, unknown>,
  overrides: Partial<DocumentTask> = {},
): DocumentTask {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    status: 'todo',
    priority: 'medium',
    dueDate: null,
    connectorType: 'document-intelligence',
    connectorInstanceId: 'owl',
    sourceId: id,
    sourceUrl: null,
    createdAt: '2026-08-01T12:00:00Z',
    updatedAt: '2026-08-01T12:00:00Z',
    metadata: JSON.stringify(metadata),
    ...overrides,
  };
}

const tasks = [
  task('pay', { actionType: 'pay', urgency: 'critical', amount: 125, correspondent: 'Acme' }, {
    dueDate: '2026-08-20',
  }),
  task('review', { actionType: 'review', urgency: 'medium', correspondent: 'Beta' }, {
    dueDate: '2026-08-23',
  }),
  task('sign', { actionType: 'sign', urgency: 'high', amount: 25, correspondent: 'Acme' }, {
    dueDate: '2026-09-01',
  }),
];

describe('document workspace semantics', () => {
  it('treats curated views as projections over the action queue', () => {
    const counts = countDocumentViews(tasks, NOW);

    expect(counts.all).toBe(3);
    expect(counts.payments).toBe(1);
    expect(counts['review-sign']).toBe(2);
    expect(counts['due-soon']).toBe(1);
    expect(counts.overdue).toBe(1);
  });

  it('combines views, facets, and document-aware search', () => {
    const filtered = filterDocumentTasks(tasks, {
      view: 'review-sign',
      actionType: 'all',
      category: 'all',
      urgency: 'medium',
      correspondent: 'all',
      query: 'beta',
    }, NOW);

    expect(filtered.map((item) => item.id)).toEqual(['review']);
  });

  it('keeps deadlines first regardless of the selected secondary sort', () => {
    const sorted = sortDocumentTasks(tasks, 'amount', 'asc');
    const descending = sortDocumentTasks(tasks, 'amount', 'desc');
    const grouped = groupDocumentTasks(sorted, 'correspondent');

    expect(sorted.map((item) => item.id)).toEqual(['pay', 'review', 'sign']);
    expect(descending.map((item) => item.id)).toEqual(['pay', 'review', 'sign']);
    expect(grouped.map((group) => [group.label, group.tasks.length])).toEqual([
      ['Acme', 2],
      ['Beta', 1],
    ]);
  });

  it('uses action type and category only after deadlines tie', () => {
    const tied = [
      task('archive', { actionType: 'archive', category: 'records' }, { dueDate: '2026-08-25' }),
      task('pay-tied', { actionType: 'pay', category: 'finance' }, { dueDate: '2026-08-25' }),
      task('respond-tied', { actionType: 'respond', category: 'correspondence' }, { dueDate: '2026-08-25' }),
    ];

    expect(sortDocumentTasks(tied, 'priority', 'asc').map((item) => item.id)).toEqual([
      'respond-tied',
      'pay-tied',
      'archive',
    ]);
  });

  it('groups deadlines into the planning horizon buckets', () => {
    const horizonTasks = [
      task('overdue', {}, { dueDate: '2026-08-20' }),
      task('today', {}, { dueDate: '2026-08-21' }),
      task('week', {}, { dueDate: '2026-08-28' }),
      task('later', {}, { dueDate: '2026-08-29' }),
      task('none', {}, { dueDate: null }),
    ];

    expect(groupDocumentTasks(horizonTasks, 'dueDate', NOW).map((group) => group.label)).toEqual([
      'Overdue',
      'Due today',
      'Next 7 days',
      'Later',
      'No due date',
    ]);
  });

  it('tolerates malformed connector metadata', () => {
    expect(parseDocumentTaskMetadata('{broken')).toEqual({});
    expect(parseDocumentTaskMetadata(JSON.stringify({
      actionType: 42,
      amount: '12.50',
      correspondent: { name: 'Acme' },
    }))).toEqual({
      actionType: undefined,
      category: undefined,
      urgency: undefined,
      amount: undefined,
      correspondent: undefined,
      documentTitle: undefined,
      documentType: undefined,
      documentUrl: undefined,
      previewUrl: undefined,
      previewType: undefined,
      previewLabel: undefined,
      documentId: undefined,
      docHubUrl: undefined,
    });
  });
});
