/**
 * Document Hub Deep Link Tests — Phase 6 (#721)
 *
 * Verifies deep link URL generation for the DI Hub admin UI,
 * and that docHubUrl is correctly populated on tasks and notifications.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDocHubUrl,
  buildDocHubTaskLinks,
  buildDocHubEobUrl,
  buildDocHubStatementsUrl,
} from '@/lib/connectors/document-intelligence/doc-hub-links';
import {
  mapActionToTask,
  mapMissingStatementToNotification,
  mapUnmatchedEobToNotification,
} from '@/lib/connectors/document-intelligence/document-parser';
import type {
  DocAction,
  MissingStatement,
  UnmatchedEob,
} from '@/lib/connectors/document-intelligence/document-parser';

const BASE_URL = 'http://localhost:8200';
const PROD_URL = 'https://doc-intel.example';
const CONNECTOR_TYPE = 'document-intelligence';
const CONNECTOR_ID = 'di-test-1';
const PAPERLESS_URL = 'http://paperless.example:8000';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeAction(overrides?: Partial<DocAction>): DocAction {
  return {
    id: 'act-123',
    document_id: 42,
    document_title: 'Invoice #456',
    action_type: 'pay',
    urgency: 'high',
    due_date: '2026-07-30',
    amount: 250.0,
    correspondent: 'Acme Corp',
    summary: 'Pay outstanding invoice',
    status: 'pending',
    created_at: '2026-07-20T12:00:00Z',
    document_url: 'http://paperless.example:8000/documents/42',
    ...overrides,
  };
}

function makeMissingStatement(overrides?: Partial<MissingStatement>): MissingStatement {
  return {
    id: 'stmt-5',
    correspondent: 'First National Bank',
    correspondent_id: 7,
    expected_period: '2026-06',
    frequency: 'monthly',
    last_received_date: '2026-05-15',
    days_overdue: 20,
    ...overrides,
  };
}

function makeUnmatchedEob(overrides?: Partial<UnmatchedEob>): UnmatchedEob {
  return {
    id: 'eob-99',
    provider: 'Dr. Smith',
    amount: 350.0,
    date_of_service: '2026-06-15',
    patient_responsibility: 125.0,
    document_url: 'http://paperless.example:8000/documents/99',
    created_at: '2026-07-01T10:00:00Z',
    ...overrides,
  };
}

// ─── buildDocHubUrl ────────────────────────────────────────────────────────

describe('buildDocHubUrl', () => {
  it('builds action URLs', () => {
    expect(buildDocHubUrl({ baseUrl: BASE_URL, type: 'action', id: 'act-123' }))
      .toBe('http://localhost:8200/admin/actions/act-123');
  });

  it('builds EOB URLs', () => {
    expect(buildDocHubUrl({ baseUrl: BASE_URL, type: 'eob', id: 'eob-99' }))
      .toBe('http://localhost:8200/admin/eob/eob-99');
  });

  it('builds statement URL (no ID needed)', () => {
    expect(buildDocHubUrl({ baseUrl: BASE_URL, type: 'statement' }))
      .toBe('http://localhost:8200/admin/statements');
  });

  it('builds document URLs', () => {
    expect(buildDocHubUrl({ baseUrl: BASE_URL, type: 'document', id: 42 }))
      .toBe('http://localhost:8200/admin/documents/42');
  });

  it('strips trailing slash from base URL', () => {
    expect(buildDocHubUrl({ baseUrl: 'http://localhost:8200/', type: 'action', id: 'x' }))
      .toBe('http://localhost:8200/admin/actions/x');
  });

  it('works with production URL', () => {
    expect(buildDocHubUrl({ baseUrl: PROD_URL, type: 'action', id: 'act-1' }))
      .toBe('https://doc-intel.example/admin/actions/act-1');
  });

  it('returns null if baseUrl is empty', () => {
    expect(buildDocHubUrl({ baseUrl: '', type: 'action', id: 'x' })).toBeNull();
  });

  it('returns null if ID missing for action/eob/document', () => {
    expect(buildDocHubUrl({ baseUrl: BASE_URL, type: 'action' })).toBeNull();
    expect(buildDocHubUrl({ baseUrl: BASE_URL, type: 'eob' })).toBeNull();
    expect(buildDocHubUrl({ baseUrl: BASE_URL, type: 'document' })).toBeNull();
  });

  it('encodes special characters in IDs', () => {
    expect(buildDocHubUrl({ baseUrl: BASE_URL, type: 'action', id: 'foo/bar' }))
      .toBe('http://localhost:8200/admin/actions/foo%2Fbar');
  });
});

// ─── buildDocHubTaskLinks ──────────────────────────────────────────────────

describe('buildDocHubTaskLinks', () => {
  it('returns both actionUrl and documentUrl', () => {
    const links = buildDocHubTaskLinks(BASE_URL, 'act-123', 42);
    expect(links.actionUrl).toBe('http://localhost:8200/admin/actions/act-123');
    expect(links.documentUrl).toBe('http://localhost:8200/admin/documents/42');
  });

  it('returns null documentUrl when no documentId', () => {
    const links = buildDocHubTaskLinks(BASE_URL, 'act-123');
    expect(links.actionUrl).toBe('http://localhost:8200/admin/actions/act-123');
    expect(links.documentUrl).toBeNull();
  });
});

// ─── buildDocHubEobUrl ─────────────────────────────────────────────────────

describe('buildDocHubEobUrl', () => {
  it('builds EOB admin URL', () => {
    expect(buildDocHubEobUrl(BASE_URL, 'eob-99'))
      .toBe('http://localhost:8200/admin/eob/eob-99');
  });
});

// ─── buildDocHubStatementsUrl ──────────────────────────────────────────────

describe('buildDocHubStatementsUrl', () => {
  it('builds statements admin URL', () => {
    expect(buildDocHubStatementsUrl(BASE_URL))
      .toBe('http://localhost:8200/admin/statements');
  });
});

// ─── Integration: docHubUrl in task metadata ───────────────────────────────

describe('mapActionToTask with docHubBaseUrl', () => {
  it('populates docHubUrl in metadata when baseUrl provided', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID, BASE_URL);
    expect(task.metadata.docHubUrl).toBe('http://localhost:8200/admin/actions/act-123');
  });

  it('populates docHubDocumentUrl in metadata', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID, BASE_URL);
    expect(task.metadata.docHubDocumentUrl).toBe('http://localhost:8200/admin/documents/42');
  });

  it('omits docHubUrl when no baseUrl provided', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(task.metadata.docHubUrl).toBeNull();
  });

  it('populates the Paperless document link alongside docHubUrl', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID, BASE_URL);
    expect(task.metadata.previewUrl).toBe('http://paperless.example:8000/documents/42');
    expect(task.metadata.previewType).toBe('external');
    expect(task.metadata.docHubUrl).toBe('http://localhost:8200/admin/actions/act-123');
  });

  it('uses production URL correctly', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID, PROD_URL);
    expect(task.metadata.docHubUrl).toBe('https://doc-intel.example/admin/actions/act-123');
  });
});

// ─── Integration: docHubUrl in notification metadata ───────────────────────

describe('mapMissingStatementToNotification with docHubBaseUrl', () => {
  it('populates docHubUrl pointing to statements admin page', () => {
    const alert = mapMissingStatementToNotification(
      makeMissingStatement(), CONNECTOR_TYPE, CONNECTOR_ID, PAPERLESS_URL, BASE_URL
    );
    expect(alert.metadata.docHubUrl).toBe('http://localhost:8200/admin/statements');
  });

  it('omits docHubUrl when no baseUrl provided', () => {
    const alert = mapMissingStatementToNotification(
      makeMissingStatement(), CONNECTOR_TYPE, CONNECTOR_ID, PAPERLESS_URL
    );
    expect(alert.metadata.docHubUrl).toBeUndefined();
  });
});

describe('mapUnmatchedEobToNotification with docHubBaseUrl', () => {
  it('populates docHubUrl pointing to EOB admin page', () => {
    const alert = mapUnmatchedEobToNotification(
      makeUnmatchedEob(), CONNECTOR_TYPE, CONNECTOR_ID, BASE_URL
    );
    expect(alert.metadata.docHubUrl).toBe('http://localhost:8200/admin/eob/eob-99');
  });

  it('omits docHubUrl when no baseUrl provided', () => {
    const alert = mapUnmatchedEobToNotification(
      makeUnmatchedEob(), CONNECTOR_TYPE, CONNECTOR_ID
    );
    expect(alert.metadata.docHubUrl).toBeUndefined();
  });
});
