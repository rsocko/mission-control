/**
 * Document Intelligence Parser Tests — Phase 2 (#714)
 *
 * Verifies that previewUrl, previewType, and previewLabel are correctly
 * populated on all DI tasks and notifications, and that null document_url is handled.
 */
import { describe, it, expect } from 'vitest';
import {
  mapActionToTask,
  mapMissingStatementToNotification,
  mapUnmatchedEobToNotification,
  isTaskAction,
  isSinceMatch,
} from '@/lib/connectors/document-intelligence/document-parser';
import type {
  DocAction,
  MissingStatement,
  UnmatchedEob,
} from '@/lib/connectors/document-intelligence/document-parser';

const CONNECTOR_TYPE = 'document-intelligence';
const CONNECTOR_ID = 'di-test-1';
const PAPERLESS_URL = 'http://paperless.example:8000';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeAction(overrides?: Partial<DocAction>): DocAction {
  return {
    id: 'act-1',
    document_id: 42,
    document_title: 'Invoice #123',
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
    id: 'stmt-1',
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
    id: 'eob-1',
    provider: 'Dr. Smith',
    amount: 350.0,
    date_of_service: '2026-06-15',
    patient_responsibility: 125.0,
    document_url: 'http://paperless.example:8000/documents/99',
    created_at: '2026-07-01T10:00:00Z',
    ...overrides,
  };
}

// ─── mapActionToTask ───────────────────────────────────────────────────────

describe('mapActionToTask', () => {
  it('builds a Paperless PDF preview URL from document_url', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(task.metadata.previewUrl).toBe('http://paperless.example:8000/api/documents/42/preview/');
  });

  it('renders the Paperless preview as a PDF', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(task.metadata.previewType).toBe('pdf');
  });

  it('sets previewLabel to "View in Paperless-ngx"', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(task.metadata.previewLabel).toBe('View in Paperless-ngx');
  });

  it('handles undefined document_url gracefully', () => {
    const task = mapActionToTask(makeAction({ document_url: undefined }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(task.metadata.previewUrl).toBeUndefined();
  });

  it('preserves other metadata fields alongside preview fields', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(task.metadata.actionType).toBe('pay');
    expect(task.metadata.amount).toBe(250.0);
    expect(task.metadata.correspondent).toBe('Acme Corp');
    expect(task.metadata.documentId).toBe(42);
    expect(task.metadata.documentTitle).toBe('Invoice #123');
  });

  it('maps all action types correctly', () => {
    const types: DocAction['action_type'][] = ['pay', 'respond', 'sign', 'schedule', 'file', 'review'];
    for (const actionType of types) {
      const task = mapActionToTask(makeAction({ action_type: actionType }), CONNECTOR_TYPE, CONNECTOR_ID);
      expect(task.metadata.actionType).toBe(actionType);
      expect(task.metadata.previewUrl).toBeDefined();
    }
  });

  it('builds title with correspondent and amount for pay actions', () => {
    const task = mapActionToTask(makeAction(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(task.title).toBe('Pay: Acme Corp — $250');
  });

  it('maps urgency to priority correctly', () => {
    expect(mapActionToTask(makeAction({ urgency: 'critical' }), CONNECTOR_TYPE, CONNECTOR_ID).priority).toBe('critical');
    expect(mapActionToTask(makeAction({ urgency: 'high' }), CONNECTOR_TYPE, CONNECTOR_ID).priority).toBe('high');
    expect(mapActionToTask(makeAction({ urgency: 'medium' }), CONNECTOR_TYPE, CONNECTOR_ID).priority).toBe('medium');
    expect(mapActionToTask(makeAction({ urgency: 'low' }), CONNECTOR_TYPE, CONNECTOR_ID).priority).toBe('low');
  });

  it('maps action statuses correctly', () => {
    expect(mapActionToTask(makeAction({ status: 'pending' }), CONNECTOR_TYPE, CONNECTOR_ID).status).toBe('todo');
    expect(mapActionToTask(makeAction({ status: 'in_progress' }), CONNECTOR_TYPE, CONNECTOR_ID).status).toBe('in_progress');
    expect(mapActionToTask(makeAction({ status: 'done' }), CONNECTOR_TYPE, CONNECTOR_ID).status).toBe('done');
    expect(mapActionToTask(makeAction({ status: 'dismissed' }), CONNECTOR_TYPE, CONNECTOR_ID).status).toBe('cancelled');
  });
});

// ─── mapMissingStatementToNotification ─────────────────────────────────────

describe('mapMissingStatementToNotification', () => {
  it('populates previewUrl from Paperless URL', () => {
    const alert = mapMissingStatementToNotification(makeMissingStatement(), CONNECTOR_TYPE, CONNECTOR_ID, PAPERLESS_URL);
    expect(alert.metadata.previewUrl).toContain(PAPERLESS_URL);
    expect(alert.metadata.previewUrl).toContain('correspondent=7');
  });

  it('sets previewType to "external"', () => {
    const alert = mapMissingStatementToNotification(makeMissingStatement(), CONNECTOR_TYPE, CONNECTOR_ID, PAPERLESS_URL);
    expect(alert.metadata.previewType).toBe('external');
  });

  it('sets previewLabel to "View in Paperless-ngx"', () => {
    const alert = mapMissingStatementToNotification(makeMissingStatement(), CONNECTOR_TYPE, CONNECTOR_ID, PAPERLESS_URL);
    expect(alert.metadata.previewLabel).toBe('View in Paperless-ngx');
  });

  it('handles missing paperlessBaseUrl', () => {
    const alert = mapMissingStatementToNotification(makeMissingStatement(), CONNECTOR_TYPE, CONNECTOR_ID, undefined);
    expect(alert.metadata.previewUrl).toBeUndefined();
  });

  it('handles missing correspondent_id', () => {
    const alert = mapMissingStatementToNotification(
      makeMissingStatement({ correspondent_id: undefined }),
      CONNECTOR_TYPE, CONNECTOR_ID, PAPERLESS_URL,
    );
    expect(alert.metadata.previewUrl).toBeUndefined();
  });

  it('sets level based on days overdue', () => {
    const highAlert = mapMissingStatementToNotification(makeMissingStatement({ days_overdue: 20 }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(highAlert.level).toBe('action_needed');

    const medAlert = mapMissingStatementToNotification(makeMissingStatement({ days_overdue: 7 }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(medAlert.level).toBe('heads_up');

    const lowAlert = mapMissingStatementToNotification(makeMissingStatement({ days_overdue: 3 }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(lowAlert.level).toBe('fyi');

    const criticalAlert = mapMissingStatementToNotification(makeMissingStatement({ days_overdue: 35 }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(criticalAlert.level).toBe('urgent');
  });

  it('includes statement metadata fields', () => {
    const alert = mapMissingStatementToNotification(makeMissingStatement(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(alert.metadata.correspondent).toBe('First National Bank');
    expect(alert.metadata.daysOverdue).toBe(20);
    expect(alert.metadata.frequency).toBe('monthly');
    expect(alert.metadata.expectedPeriod).toBe('2026-06');
  });
});

// ─── mapUnmatchedEobToNotification ─────────────────────────────────────────

describe('mapUnmatchedEobToNotification', () => {
  it('populates previewUrl from document_url', () => {
    const alert = mapUnmatchedEobToNotification(makeUnmatchedEob(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(alert.metadata.previewUrl).toBe('http://paperless.example:8000/documents/99');
  });

  it('sets previewType to "external"', () => {
    const alert = mapUnmatchedEobToNotification(makeUnmatchedEob(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(alert.metadata.previewType).toBe('external');
  });

  it('sets previewLabel to "View in Paperless-ngx"', () => {
    const alert = mapUnmatchedEobToNotification(makeUnmatchedEob(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(alert.metadata.previewLabel).toBe('View in Paperless-ngx');
  });

  it('handles undefined document_url', () => {
    const alert = mapUnmatchedEobToNotification(makeUnmatchedEob({ document_url: undefined }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(alert.metadata.previewUrl).toBeUndefined();
  });

  it('sets level based on patient responsibility and amount', () => {
    const highAlert = mapUnmatchedEobToNotification(makeUnmatchedEob({ patient_responsibility: 200 }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(highAlert.level).toBe('action_needed');

    const lowAlert = mapUnmatchedEobToNotification(makeUnmatchedEob({ patient_responsibility: 50 }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(lowAlert.level).toBe('fyi');

    const medAlert = mapUnmatchedEobToNotification(makeUnmatchedEob({ patient_responsibility: 125 }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(medAlert.level).toBe('heads_up');

    const criticalAlert = mapUnmatchedEobToNotification(makeUnmatchedEob({ patient_responsibility: 600 }), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(criticalAlert.level).toBe('urgent');
  });

  it('includes EOB metadata fields', () => {
    const alert = mapUnmatchedEobToNotification(makeUnmatchedEob(), CONNECTOR_TYPE, CONNECTOR_ID);
    expect(alert.metadata.provider).toBe('Dr. Smith');
    expect(alert.metadata.amount).toBe(350.0);
    expect(alert.metadata.patientResponsibility).toBe(125.0);
    expect(alert.metadata.dateOfService).toBe('2026-06-15');
  });
});

// ─── Utility functions ─────────────────────────────────────────────────────

describe('isTaskAction', () => {
  it('returns true for all task action types', () => {
    const taskTypes: DocAction['action_type'][] = ['pay', 'respond', 'sign', 'schedule', 'file', 'review'];
    for (const t of taskTypes) {
      expect(isTaskAction(makeAction({ action_type: t }))).toBe(true);
    }
  });
});

describe('isSinceMatch', () => {
  it('returns true when no since filter', () => {
    expect(isSinceMatch('2026-01-01')).toBe(true);
  });

  it('returns true when value is after since', () => {
    expect(isSinceMatch('2026-07-20', new Date('2026-07-01'))).toBe(true);
  });

  it('returns false when value is before since', () => {
    expect(isSinceMatch('2026-06-01', new Date('2026-07-01'))).toBe(false);
  });

  it('returns true when value is undefined', () => {
    expect(isSinceMatch(undefined, new Date('2026-07-01'))).toBe(true);
  });
});
