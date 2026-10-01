import { describe, expect, it } from 'vitest';
import type { RyMessageActionProjection } from '@/db/persistence/rymessage-actions';
import type { CompanionActionV1 } from '@/lib/connectors/rymessage/action-contract';
import { sanitizeCompanionAction } from '@/lib/connectors/rymessage/action-contract';
import { rymessageNotificationProjection } from '@/lib/connectors/rymessage/notification-projection';

const NOW = '2026-09-29T22:00:00.000Z';

function action(overrides: Partial<CompanionActionV1> = {}): CompanionActionV1 {
  return {
    contractVersion: 1,
    actionId: '00000000-0000-4000-8000-000000000001',
    stableKey: `ak1:${'a'.repeat(64)}`,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    source: {
      identity: { kind: 'provider_message', provider: 'microsoft', id: 'secret-message' },
      sourceKind: 'message',
      senderDisplayName: 'Secret Sender',
      conversationTitle: 'Secret Thread',
      messageExcerpt: 'Secret excerpt',
    },
    content: {
      title: 'Review report',
      summary: 'Portable summary',
      actionType: 'follow-up',
      priority: 'high',
    },
    classification: {
      confidenceClass: 'low',
      confidenceScore: 0.2,
      reason: 'Secret model reasoning',
      derivationMethod: 'ai',
      model: 'secret-model',
      inputFingerprint: 'b'.repeat(64),
      extractedPayload: { secret: true },
    },
    lifecycle: { state: 'visible' },
    fieldRevisions: { title: 1, lifecycle: 1 },
    materializations: [],
    ...overrides,
  };
}

function projection(canonicalAction: CompanionActionV1 | null): RyMessageActionProjection {
  return {
    connectorId: 'rymessage-1',
    actionId: canonicalAction?.actionId ?? '00000000-0000-4000-8000-000000000001',
    revision: canonicalAction?.revision ?? 2,
    sourceId: 'private-source-id',
    action: canonicalAction ? sanitizeCompanionAction(canonicalAction) : null,
    tombstonedAt: canonicalAction ? null : NOW,
  };
}

describe('RyMessage notification projection', () => {
  it('projects every confidence class with stable identity and severity-only confidence effects', () => {
    const low = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action()),
    );
    const high = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action({
        classification: {
          ...action().classification,
          confidenceClass: 'high',
          confidenceScore: 0.95,
        },
      })),
    );
    expect(low.sourceId).toBe(
      'rymessage:companion:rymessage-1:00000000-0000-4000-8000-000000000001',
    );
    expect(low.level).toBe('heads_up');
    expect(high.level).toBe('action_needed');
    expect(low.sourceState).toBe('active');
  });

  it('projects bounded message identity, content, and classification context', () => {
    const input = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action()),
    );
    const serialized = JSON.stringify(input);
    expect(input.title).toBe('Review report');
    expect(input.body).toBe('Secret excerpt');
    expect(input.metadata).toMatchObject({
      senderDisplayName: 'Secret Sender',
      conversationTitle: 'Secret Thread',
      messageExcerpt: 'Secret excerpt',
      classificationReason: 'Secret model reasoning',
      classificationModel: 'secret-model',
      lifecycle: 'visible',
    });
    expect(serialized).not.toContain('secret-message');
    expect(serialized).not.toContain('"secret":true');
  });

  it('converges handled, completed, and tombstoned actions to resolved/deleted state', () => {
    for (const state of ['handled', 'completed', 'dismissed'] as const) {
      expect(rymessageNotificationProjection.projectionInput(
        'rymessage-1',
        projection(action({ lifecycle: { state } })),
      ).sourceState).toBe('resolved');
    }
    const removed = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(null),
    );
    expect(removed.sourceState).toBe('deleted');
    expect(removed.isActionable).toBe(false);
  });
});
