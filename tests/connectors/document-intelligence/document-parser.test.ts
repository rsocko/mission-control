/**
 * Document Intelligence Parser — Unit Tests
 *
 * Tests for data transformation from DI API responses to MC TaskItem/InboundNotification/TriageItem.
 */

import { describe, expect, it } from 'vitest';
import {
  isTaskAction,
  isSinceMatch,
  mapActionToTask,
  mapMissingStatementToNotification,
  mapUnmatchedEobToNotification,
  mapActionToTriageItem,
  mapStatementOverdueSeverity,
  mapEobSeverity,
  type DocAction,
  type MissingStatement,
  type UnmatchedEob,
} from '@/lib/connectors/document-intelligence/document-parser';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONNECTOR_TYPE = 'document-intelligence';
const CONNECTOR_INSTANCE_ID = 'di-instance-1';

const mockPayAction: DocAction = {
  id: 'action-001',
  document_id: 42,
  document_title: 'PG&E Bill - July 2026',
  action_type: 'pay',
  urgency: 'high',
  due_date: '2026-07-31',
  amount: 143.22,
  correspondent: 'PG&E',
  summary: 'Monthly electric bill due July 31',
  status: 'pending',
  created_at: '2026-07-15T10:00:00Z',
  document_url: 'https://paperless.example/documents/42',
};

const mockFileAction: DocAction = {
  id: 'action-002',
  document_id: 55,
  document_title: 'Tax Form W-2',
  action_type: 'file',
  urgency: 'low',
  due_date: null,
  amount: null,
  correspondent: null,
  summary: 'W-2 form needs to be filed',
  status: 'pending',
  created_at: '2026-07-10T08:00:00Z',
  document_url: 'https://paperless.example/documents/55',
};

const mockMissingStatement: MissingStatement = {
  id: 'usbank-stmt-july',
  correspondent: 'USBank',
  correspondent_id: 17,
  expected_period: '2026-07',
  frequency: 'monthly',
  last_received_date: '2026-06-03',
  days_overdue: 4,
};

const mockUnmatchedEob: UnmatchedEob = {
  id: 'eob-101',
  provider: 'Dr. Ana Martinez',
  amount: 350.0,
  date_of_service: '2026-06-15',
  patient_responsibility: 75.0,
  document_url: 'https://paperless.example/documents/101',
  created_at: '2026-07-01T12:00:00Z',
};

// ─── isTaskAction Tests ──────────────────────────────────────────────────────

describe('isTaskAction', () => {
  it('returns true for all valid action types', () => {
    const actionTypes: DocAction['action_type'][] = ['pay', 'respond', 'sign', 'schedule', 'file', 'review'];
    for (const type of actionTypes) {
      expect(isTaskAction({ ...mockPayAction, action_type: type })).toBe(true);
    }
  });

  it('returns false for unknown action types', () => {
    expect(isTaskAction({ ...mockPayAction, action_type: 'unknown' as DocAction['action_type'] })).toBe(false);
  });
});

// ─── isSinceMatch Tests ──────────────────────────────────────────────────────

describe('isSinceMatch', () => {
  it('returns true when no since date provided', () => {
    expect(isSinceMatch('2026-01-01T00:00:00Z')).toBe(true);
  });

  it('returns true when no value provided', () => {
    expect(isSinceMatch(undefined, new Date('2026-01-01'))).toBe(true);
  });

  it('returns true when value is after since', () => {
    expect(isSinceMatch('2026-07-15T00:00:00Z', new Date('2026-07-01'))).toBe(true);
  });

  it('returns false when value is before since', () => {
    expect(isSinceMatch('2026-06-15T00:00:00Z', new Date('2026-07-01'))).toBe(false);
  });

  it('handles invalid date strings gracefully', () => {
    expect(isSinceMatch('not-a-date', new Date('2026-07-01'))).toBe(true);
  });
});

// ─── mapActionToTask Tests ───────────────────────────────────────────────────

describe('mapActionToTask', () => {
  it('maps a pay action with amount and correspondent', () => {
    const task = mapActionToTask(mockPayAction, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(task.id).toBe('docintel-action-001');
    expect(task.sourceId).toBe('action-001');
    expect(task.title).toBe('Pay: PG&E — $143.22');
    expect(task.description).toBe('Monthly electric bill due July 31');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('high');
    expect(task.dueDate).toBe('2026-07-31');
    expect(task.connectorType).toBe(CONNECTOR_TYPE);
    expect(task.connectorInstanceId).toBe(CONNECTOR_INSTANCE_ID);
  });

  it('maps metadata correctly', () => {
    const task = mapActionToTask(mockPayAction, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    const meta = task.metadata as Record<string, unknown>;
    expect(meta.previewUrl).toBe('https://paperless.example/api/documents/42/thumb/');
    expect(meta.previewType).toBe('image');
    expect(meta.previewLabel).toBe('View in Paperless-ngx');
    expect(meta.amount).toBe(143.22);
    expect(meta.correspondent).toBe('PG&E');
    expect(meta.actionType).toBe('pay');
  });

  it('prefers an OWL-provided rich preview', () => {
    const task = mapActionToTask({
      ...mockPayAction,
      preview_url: 'https://owl.example/previews/42.pdf',
      preview_type: 'pdf',
      thumbnail_url: 'https://owl.example/thumbnails/42.webp',
    }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);

    expect(task.metadata.previewUrl).toBe('https://owl.example/previews/42.pdf');
    expect(task.metadata.previewType).toBe('pdf');
    expect(task.metadata.documentUrl).toBe(mockPayAction.document_url);
  });

  it('uses an OWL-provided thumbnail when no rich preview is available', () => {
    const task = mapActionToTask({
      ...mockPayAction,
      thumbnail_url: 'https://owl.example/thumbnails/42.webp',
    }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);

    expect(task.metadata.previewUrl).toBe('https://owl.example/thumbnails/42.webp');
    expect(task.metadata.previewType).toBe('image');
  });

  it('maps a file action without amount', () => {
    const task = mapActionToTask(mockFileAction, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(task.title).toBe('File: Tax Form W-2');
    expect(task.priority).toBe('low');
    expect(task.dueDate).toBeUndefined();
  });

  it('maps statuses correctly', () => {
    const statuses: [DocAction['status'], string][] = [
      ['pending', 'todo'],
      ['in_progress', 'in_progress'],
      ['done', 'done'],
      ['dismissed', 'cancelled'],
    ];
    for (const [diStatus, mcStatus] of statuses) {
      const task = mapActionToTask({ ...mockPayAction, status: diStatus }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
      expect(task.status).toBe(mcStatus);
    }
  });

  it('maps urgency to priority correctly', () => {
    const urgencies: [DocAction['urgency'], string][] = [
      ['critical', 'critical'],
      ['high', 'high'],
      ['medium', 'medium'],
      ['low', 'low'],
    ];
    for (const [urgency, priority] of urgencies) {
      const task = mapActionToTask({ ...mockPayAction, urgency }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
      expect(task.priority).toBe(priority);
    }
  });

  it('includes correct tags', () => {
    const task = mapActionToTask(mockPayAction, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(task.tags).toHaveLength(4);
    expect(task.tags![0].slug).toBe('action-queue');
    expect(task.tags![1].slug).toBe('pay');
    expect(task.tags![2].slug).toBe('high');
    expect(task.tags![3].slug).toBe('correspondent-pg-e');
    expect(task.tags![3].name).toBe('PG&E');
  });

  it('omits correspondent tag when correspondent is null', () => {
    const task = mapActionToTask(mockFileAction, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(task.tags).toHaveLength(3);
    expect(task.tags!.every(t => !t.slug.startsWith('correspondent-'))).toBe(true);
  });

  it('builds title variants for each action type', () => {
    expect(mapActionToTask({ ...mockFileAction, action_type: 'respond' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).title)
      .toBe('Respond to: Tax Form W-2');
    expect(mapActionToTask({ ...mockFileAction, action_type: 'sign' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).title)
      .toBe('Sign: Tax Form W-2');
    expect(mapActionToTask({ ...mockFileAction, action_type: 'schedule' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).title)
      .toBe('Schedule: Tax Form W-2');
    expect(mapActionToTask({ ...mockFileAction, action_type: 'review' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).title)
      .toBe('Review: Tax Form W-2');
  });

  it('sets sourceListId to the bare sourceId (not compound id)', () => {
    const task = mapActionToTask(mockPayAction, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    // sourceListId must match sourceList.sourceId so the API list filter works
    expect(task.sourceListId).toBe('action-queue');
    expect(task.sourceListId).not.toContain(CONNECTOR_INSTANCE_ID);
  });
});

// ─── mapMissingStatementToNotification Tests ────────────────────────────────

describe('mapMissingStatementToNotification', () => {
  it('maps a missing statement to a notification', () => {
    const alert = mapMissingStatementToNotification(mockMissingStatement, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID, 'https://paperless.example');
    expect(alert.id).toBe('docintel-stmt-usbank-stmt-july');
    expect(alert.sourceId).toBe('stmt-usbank-stmt-july');
    expect(alert.title).toContain('USBank');
    expect(alert.title).toContain('2026-07');
    expect(alert.level).toBe('fyi'); // 4 days overdue < 7
    expect(alert.category).toBe('document');
    expect(alert.isActionable).toBe(true);
  });

  it('sets graduated level based on days overdue', () => {
    const lowStmt = { ...mockMissingStatement, days_overdue: 3 };
    expect(mapMissingStatementToNotification(lowStmt, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('fyi');

    const mediumStmt = { ...mockMissingStatement, days_overdue: 10 };
    expect(mapMissingStatementToNotification(mediumStmt, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('heads_up');

    const highStmt = { ...mockMissingStatement, days_overdue: 20 };
    expect(mapMissingStatementToNotification(highStmt, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('action_needed');

    const criticalStmt = { ...mockMissingStatement, days_overdue: 35 };
    expect(mapMissingStatementToNotification(criticalStmt, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('urgent');
  });

  it('includes metadata with daysOverdue', () => {
    const alert = mapMissingStatementToNotification(mockMissingStatement, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID, 'https://paperless.example');
    const meta = alert.metadata as Record<string, unknown>;
    expect(meta.daysOverdue).toBe(4);
    expect(meta.frequency).toBe('monthly');
    expect(meta.correspondent).toBe('USBank');
  });

  it('builds paperless action URL when correspondent_id is provided', () => {
    const alert = mapMissingStatementToNotification(mockMissingStatement, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID, 'https://paperless.example');
    expect(alert.actionUrl).toContain('paperless.example');
    expect(alert.actionUrl).toContain('correspondent=17');
  });

  it('handles missing paperlessBaseUrl gracefully', () => {
    const alert = mapMissingStatementToNotification(mockMissingStatement, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(alert.actionUrl).toBeUndefined();
  });
});

// ─── mapUnmatchedEobToNotification Tests ────────────────────────────────────

describe('mapUnmatchedEobToNotification', () => {
  it('maps an unmatched EOB to a notification', () => {
    const alert = mapUnmatchedEobToNotification(mockUnmatchedEob, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(alert.id).toBe('docintel-eob-eob-101');
    expect(alert.sourceId).toBe('eob-eob-101');
    expect(alert.title).toContain('Dr. Ana Martinez');
    expect(alert.title).toContain('$350');
    expect(alert.category).toBe('medical');
    expect(alert.isActionable).toBe(true);
  });

  it('sets graduated level based on patient responsibility and amount', () => {
    const alert = mapUnmatchedEobToNotification(mockUnmatchedEob, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(alert.level).toBe('fyi'); // $75 patient responsibility, $350 total

    const mediumEob = { ...mockUnmatchedEob, patient_responsibility: 120 };
    expect(mapUnmatchedEobToNotification(mediumEob, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('heads_up');

    const highEob = { ...mockUnmatchedEob, patient_responsibility: 250 };
    expect(mapUnmatchedEobToNotification(highEob, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('action_needed');

    const criticalEob = { ...mockUnmatchedEob, patient_responsibility: 600 };
    expect(mapUnmatchedEobToNotification(criticalEob, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('urgent');
  });

  it('escalates level for high total amounts regardless of patient responsibility', () => {
    const highTotal = { ...mockUnmatchedEob, amount: 750, patient_responsibility: 50 };
    expect(mapUnmatchedEobToNotification(highTotal, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('action_needed');

    const criticalTotal = { ...mockUnmatchedEob, amount: 1200, patient_responsibility: 50 };
    expect(mapUnmatchedEobToNotification(criticalTotal, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID).level).toBe('urgent');
  });

  it('includes correct metadata', () => {
    const alert = mapUnmatchedEobToNotification(mockUnmatchedEob, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    const meta = alert.metadata as Record<string, unknown>;
    expect(meta.provider).toBe('Dr. Ana Martinez');
    expect(meta.amount).toBe(350.0);
    expect(meta.patientResponsibility).toBe(75.0);
    expect(meta.previewUrl).toBe('https://paperless.example/documents/101');
  });

  it('includes EOB matching tag', () => {
    const alert = mapUnmatchedEobToNotification(mockUnmatchedEob, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(alert.tags![0].slug).toBe('eob-matching');
  });
});

// ─── mapActionToTriageItem Tests ─────────────────────────────────────────────

describe('mapActionToTriageItem', () => {
  it('maps a pay action to a triage item', () => {
    const item = mapActionToTriageItem(mockPayAction, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(item.id).toBe('docintel-triage-action-001');
    expect(item.sourcePlatform).toBe('document-intelligence');
    expect(item.contentType).toBe('document');
    expect(item.title).toBe('Pay: PG&E — $143.22');
    expect(item.status).toBe('pending');
  });

  it('assigns correct urgency tiers', () => {
    const critical = mapActionToTriageItem({ ...mockPayAction, urgency: 'critical' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(critical.aiUrgency).toBe('time_sensitive');
    expect(critical.aiRelevanceScore).toBe(95);

    const medium = mapActionToTriageItem({ ...mockPayAction, urgency: 'medium' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(medium.aiUrgency).toBe('trending');
    expect(medium.aiRelevanceScore).toBe(65);

    const low = mapActionToTriageItem({ ...mockPayAction, urgency: 'low' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(low.aiUrgency).toBe('evergreen');
    expect(low.aiRelevanceScore).toBe(45);
  });

  it('suggests correct primary action per type', () => {
    const pay = mapActionToTriageItem({ ...mockPayAction, action_type: 'pay' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(pay.aiSuggestedActions![0].actionType).toBe('complete_action');

    const file = mapActionToTriageItem({ ...mockFileAction, action_type: 'file' }, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(file.aiSuggestedActions![0].actionType).toBe('open_document');
  });

  it('includes document URL in sourceUrl and canonicalUrl', () => {
    const item = mapActionToTriageItem(mockPayAction, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID);
    expect(item.sourceUrl).toBe('https://paperless.example/documents/42');
    expect(item.canonicalUrl).toBe('https://paperless.example/documents/42');
  });

  it('falls back to constructed URL when document_url is missing', () => {
    const noUrl = { ...mockPayAction, document_url: undefined };
    const item = mapActionToTriageItem(noUrl, CONNECTOR_TYPE, CONNECTOR_INSTANCE_ID, 'https://paperless.example');
    expect(item.sourceUrl).toBe('https://paperless.example/documents/42');
  });
});

// ─── Level Helper Tests ─────────────────────────────────────────────────────

describe('mapStatementOverdueSeverity', () => {
  it('returns fyi for <7 days', () => {
    expect(mapStatementOverdueSeverity(0)).toBe('fyi');
    expect(mapStatementOverdueSeverity(6)).toBe('fyi');
  });

  it('returns heads_up for 7–13 days', () => {
    expect(mapStatementOverdueSeverity(7)).toBe('heads_up');
    expect(mapStatementOverdueSeverity(13)).toBe('heads_up');
  });

  it('returns action_needed for 14–29 days', () => {
    expect(mapStatementOverdueSeverity(14)).toBe('action_needed');
    expect(mapStatementOverdueSeverity(29)).toBe('action_needed');
  });

  it('returns urgent for 30+ days', () => {
    expect(mapStatementOverdueSeverity(30)).toBe('urgent');
    expect(mapStatementOverdueSeverity(60)).toBe('urgent');
  });
});

describe('mapEobSeverity', () => {
  it('returns fyi for small amounts', () => {
    expect(mapEobSeverity(50, 200)).toBe('fyi');
  });

  it('returns heads_up for patient responsibility >= $100', () => {
    expect(mapEobSeverity(100, 300)).toBe('heads_up');
    expect(mapEobSeverity(199, 300)).toBe('heads_up');
  });

  it('returns action_needed for patient responsibility >= $200', () => {
    expect(mapEobSeverity(200, 400)).toBe('action_needed');
  });

  it('returns action_needed for total amount >= $500', () => {
    expect(mapEobSeverity(50, 500)).toBe('action_needed');
  });

  it('returns urgent for patient responsibility >= $500', () => {
    expect(mapEobSeverity(500, 600)).toBe('urgent');
  });

  it('returns urgent for total amount >= $1000', () => {
    expect(mapEobSeverity(50, 1000)).toBe('urgent');
  });
});
