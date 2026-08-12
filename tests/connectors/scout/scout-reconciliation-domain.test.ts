import { describe, expect, it } from 'vitest';
import {
  evaluateReconciliationPolicy,
  parseReconciliationScope,
  reconcileRequestSchema,
  scoreReconciliationEvidence,
  type ReconciliationSignal,
} from '@/lib/connectors/scout/reconciliation-domain';
import { DEFAULT_SCOUT_SETTINGS } from '@/lib/connectors/scout/settings';

function signal(
  kind: ReconciliationSignal['kind'],
  overrides: Partial<ReconciliationSignal> = {},
): ReconciliationSignal {
  const sourceType = kind === 'planner-completed'
    ? 'planner'
    : kind === 'meeting-confirmed-complete'
      ? 'meeting'
      : kind === 'teams-confirmed-handled'
        ? 'teams'
        : 'email';
  return {
    signalId: `signal-${kind}`,
    taskId: 'task-1',
    sourceType,
    kind,
    occurredAt: '2026-08-05T12:00:00.000Z',
    summary: 'Sanitized synthetic evidence',
    sourceRefHash: kind.charCodeAt(0).toString(16).padStart(64, '0'),
    ...overrides,
  };
}

const task = {
  connectorType: 'scout',
  priority: 'medium',
  dueDate: null,
};

describe('Scout reconciliation domain', () => {
  it('uses deterministic fixed weights at completion boundaries', () => {
    expect(scoreReconciliationEvidence([signal('inactivity')])).toMatchObject({
      candidateAction: 'no-change',
      confidence: 0.15,
    });
    expect(scoreReconciliationEvidence([signal('source-cancelled')])).toMatchObject({
      candidateAction: 'suggest-complete',
      confidence: 0.68,
    });
    expect(scoreReconciliationEvidence([signal('requester-confirmed-resolved')])).toMatchObject({
      candidateAction: 'auto-complete',
      confidence: 0.94,
    });
  });

  it('combines corroborating signals without trusting caller-provided confidence', () => {
    const score = scoreReconciliationEvidence([
      signal('meeting-confirmed-complete', { signalId: 'meeting-1', sourceType: 'meeting' }),
      signal('teams-confirmed-handled', { signalId: 'teams-1', sourceType: 'teams' }),
    ]);

    expect(score.candidateAction).toBe('auto-complete');
    expect(score.confidence).toBe(0.964);
    expect(score.sourceTypes).toEqual(['meeting', 'teams']);
  });

  it('classifies urgency independently from resolution evidence', () => {
    expect(scoreReconciliationEvidence([signal('blocked')])).toMatchObject({
      candidateAction: 'escalate',
      confidence: 0.72,
      suggestedPriority: 'high',
    });
    expect(scoreReconciliationEvidence([signal('urgent')])).toMatchObject({
      candidateAction: 'escalate',
      confidence: 0.85,
      suggestedPriority: 'high',
    });
  });

  it.each([
    ['high priority', { priority: 'high' }, false, [signal('requester-confirmed-resolved')], 'High-priority'],
    ['future due date', { dueDate: '2026-08-06T00:00:00.000Z' }, false, [signal('requester-confirmed-resolved')], 'future due dates'],
    ['reopen suppression', {}, true, [signal('requester-confirmed-resolved')], 'permanently excluded'],
    ['sensitive evidence', {}, false, [signal('requester-confirmed-resolved'), signal('sensitive', { signalId: 'sensitive-1' })], 'Sensitive'],
    ['ambiguous evidence', {}, false, [signal('requester-confirmed-resolved'), signal('ambiguous', { signalId: 'ambiguous-1' })], 'Ambiguous'],
  ])('denies autonomous completion for %s', (_name, taskOverrides, neverAutoComplete, signals, reason) => {
    const score = scoreReconciliationEvidence(signals as ReconciliationSignal[]);
    const policy = evaluateReconciliationPolicy({
      task: { ...task, ...taskOverrides },
      score,
      neverAutoComplete: neverAutoComplete as boolean,
      connectorEnabled: true,
      autonomy: {
        ...DEFAULT_SCOUT_SETTINGS.autonomy,
        autoExecuteActions: [{
          action: 'complete-task',
          sourceTypes: ['email'],
          target: 'scout-originated',
          minimumConfidence: 0.9,
        }],
      },
      evidenceVerified: true,
      now: new Date('2026-08-05T12:00:00.000Z'),
    });

    expect(policy.action).toBe('suggest-complete');
    expect(policy.decision).toBe('deny');
    expect(policy.reason).toContain(reason);
  });

  it('separates confidence from authority and denies execution by default', () => {
    const score = scoreReconciliationEvidence([signal('planner-completed', { sourceType: 'planner' })]);
    const denied = evaluateReconciliationPolicy({
      task,
      score,
      neverAutoComplete: false,
      connectorEnabled: true,
      autonomy: DEFAULT_SCOUT_SETTINGS.autonomy,
      evidenceVerified: false,
      now: new Date('2026-08-05T12:00:00.000Z'),
    });
    const allowed = evaluateReconciliationPolicy({
      task,
      score,
      neverAutoComplete: false,
      connectorEnabled: true,
      autonomy: {
        ...DEFAULT_SCOUT_SETTINGS.autonomy,
        autoExecuteActions: [{
          action: 'complete-task',
          sourceTypes: ['planner'],
          target: 'scout-originated',
          minimumConfidence: 0.95,
        }],
      },
      evidenceVerified: true,
      now: new Date('2026-08-05T12:00:00.000Z'),
    });

    expect(denied).toMatchObject({ action: 'suggest-complete', decision: 'deny' });
    expect(allowed).toMatchObject({ action: 'auto-complete', decision: 'allow' });
  });

  it('requires verified provenance and does not amplify duplicate source artifacts', () => {
    const sharedArtifact = 'a'.repeat(64);
    const signals = [
      signal('meeting-confirmed-complete', { signalId: 'meeting-1', sourceRefHash: sharedArtifact }),
      signal('teams-confirmed-handled', {
        signalId: 'teams-1',
        sourceType: 'teams',
        sourceRefHash: sharedArtifact,
      }),
    ];
    expect(scoreReconciliationEvidence(signals)).toMatchObject({
      candidateAction: 'suggest-complete',
      confidence: 0.82,
    });

    const denied = evaluateReconciliationPolicy({
      task,
      score: scoreReconciliationEvidence([signal('planner-completed')]),
      neverAutoComplete: false,
      connectorEnabled: true,
      autonomy: {
        ...DEFAULT_SCOUT_SETTINGS.autonomy,
        autoExecuteActions: [{
          action: 'complete-task',
          sourceTypes: ['planner'],
          target: 'scout-originated',
          minimumConfidence: 0.95,
        }],
      },
      evidenceVerified: false,
      now: new Date('2026-08-05T12:00:00.000Z'),
    });
    expect(denied).toMatchObject({ action: 'suggest-complete', decision: 'deny' });
    expect(denied.reason).toContain('provider-verified');
  });

  it('validates bounded, sanitized structured evidence and scopes', () => {
    expect(parseReconciliationScope('all')).toEqual({ type: 'all', id: null, key: 'all' });
    expect(parseReconciliationScope('project:project-1')).toEqual({
      type: 'project',
      id: 'project-1',
      key: 'project:project-1',
    });
    expect(() => parseReconciliationScope('connector:scout')).toThrow();

    expect(reconcileRequestSchema.safeParse({
      signals: [signal('planner-completed', { summary: 'raw\nmessage body' })],
    }).success).toBe(false);
    expect(reconcileRequestSchema.safeParse({
      lookbackHours: 169,
      signals: [],
    }).success).toBe(false);
    expect(reconcileRequestSchema.safeParse({
      signals: [signal('planner-completed', { sourceRefHash: 'raw-m365-id' })],
    }).success).toBe(false);
    expect(reconcileRequestSchema.safeParse({
      signals: [signal('planner-completed', { sourceRefHash: 'A'.repeat(64) })],
    }).success).toBe(false);
    expect(reconcileRequestSchema.safeParse({
      signals: [signal('planner-completed', { sourceType: 'meeting' })],
    }).success).toBe(false);
  });
});
