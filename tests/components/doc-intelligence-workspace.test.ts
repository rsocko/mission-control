import { describe, expect, it } from 'vitest';
import {
  countDocumentViews,
  buildDocumentActionHelpers,
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
      urgency: 'medium',
      correspondent: 'all',
      query: 'beta',
    }, NOW);

    expect(filtered.map((item) => item.id)).toEqual(['review']);
  });

  it('sorts missing values last and groups by document metadata', () => {
    const sorted = sortDocumentTasks(tasks, 'amount', 'asc');
    const descending = sortDocumentTasks(tasks, 'amount', 'desc');
    const grouped = groupDocumentTasks(sorted, 'correspondent');

    expect(sorted.map((item) => item.id)).toEqual(['sign', 'pay', 'review']);
    expect(descending.map((item) => item.id)).toEqual(['pay', 'sign', 'review']);
    expect(grouped.map((group) => [group.label, group.tasks.length])).toEqual([
      ['Acme', 2],
      ['Beta', 1],
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
      recommendedCta: undefined,
      extractedData: undefined,
    });
  });

  it('builds safe deduplicated action helpers in priority order', () => {
    const helpers = buildDocumentActionHelpers({
      recommendedCta: {
        id: 'pay',
        label: 'Pay invoice',
        url: 'https://billing.example/pay',
      },
      extractedData: {
        account_number: 'ACCT-123',
        reference_number: 'REF-456',
        payment_url: 'https://billing.example/pay',
        phone: '+1 (555) 010-0200',
        email: 'billing@example.com',
        links: [
          { url: 'javascript:alert(1)', label: 'Unsafe' },
          { url: 'data:text/html,unsafe', label: 'Also unsafe' },
          { url: 'https://billing.example/help', purpose: 'Get help' },
          { url: 'https://billing.example/help', label: 'Duplicate' },
        ],
      },
    });

    expect(helpers).toEqual({
      accountNumber: 'ACCT-123',
      referenceNumber: 'REF-456',
      links: [
        {
          href: 'https://billing.example/pay',
          label: 'Pay invoice',
          kind: 'web',
          primary: true,
        },
        {
          href: 'https://billing.example/help',
          label: 'Get help',
          kind: 'web',
          primary: false,
        },
        {
          href: 'tel:+15550100200',
          label: 'Call',
          kind: 'phone',
          primary: false,
        },
        {
          href: 'mailto:billing@example.com',
          label: 'Email',
          kind: 'email',
          primary: false,
        },
      ],
    });
  });
});
