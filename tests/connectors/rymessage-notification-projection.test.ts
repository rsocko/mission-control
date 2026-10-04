import { describe, expect, it } from 'vitest';
import type { ActionV2 } from '@/lib/connectors/rymessage/action-contract';
import { rymessageNotificationProjection } from '@/lib/connectors/rymessage/notification-projection';

const NOW = '2026-09-29T22:00:00.000Z';

function action(overrides: Partial<ActionV2> = {}): ActionV2 {
  return {
    contractVersion: 2,
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
      actionType: 'needs-reply',
      priority: 'none',
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

function projection(canonicalAction: ActionV2 | null) {
  return {
    connectorId: 'rymessage-1',
    actionId: canonicalAction?.actionId ?? '00000000-0000-4000-8000-000000000001',
    revision: canonicalAction?.revision ?? 2,
    sourceId: 'private-source-id',
    action: canonicalAction,
    tombstonedAt: canonicalAction ? null : NOW,
  };
}

describe('RyMessage notification projection', () => {
  it('maps semantic urgency while honoring an explicit priority first', () => {
    const low = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action()),
    );
    const waiting = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action({
        content: {
          ...action().content,
          actionType: 'waiting-on-reply',
        },
      })),
    );
    const critical = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action({
        content: {
          ...action().content,
          category: 'critical-alert',
        },
      })),
    );
    const explicitLow = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action({
        content: {
          ...action().content,
          category: 'critical-alert',
          priority: 'low',
        },
      })),
    );
    expect(low.sourceId).toBe(
      'rymessage:companion:rymessage-1:00000000-0000-4000-8000-000000000001',
    );
    expect(low.level).toBe('action_needed');
    expect(waiting.level).toBe('heads_up');
    expect(critical.level).toBe('urgent');
    expect(explicitLow.level).toBe('fyi');
    expect(low.sourceState).toBe('active');
  });

  it('maps the published RyMessage action classes to relative Mission Control urgency', () => {
    for (const semanticType of [
      'needs-reply',
      'action-required',
      'security-code',
      'travel',
      'financial',
      'shipping-delivery',
      'delivery',
      'scheduling',
      'repeated-ask',
    ]) {
      expect(rymessageNotificationProjection.projectionInput(
        'rymessage-1',
        projection(action({
          content: {
            ...action().content,
            actionType: semanticType,
          },
        })),
      ).level).toBe('action_needed');
    }

    for (const semanticType of [
      'waiting-on-reply',
      'waiting-on-action',
      'commitment',
      'snoozed-chat',
    ]) {
      expect(rymessageNotificationProjection.projectionInput(
        'rymessage-1',
        projection(action({
          content: {
            ...action().content,
            actionType: semanticType,
          },
        })),
      ).level).toBe('heads_up');
    }
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
      semanticType: 'needs-reply',
      classificationReason: 'Secret model reasoning',
      classificationModel: 'secret-model',
      lifecycle: 'visible',
    });
    expect(serialized).not.toContain('secret-message');
    expect(serialized).not.toContain('"secret":true');
  });

  it('uses category semantics first and falls back to action type for legacy rows', () => {
    const categorized = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action({
        content: {
          ...action().content,
          actionType: 'needs-reply',
          category: 'travel',
        },
      })),
    );
    const legacy = rymessageNotificationProjection.projectionInput(
      'rymessage-1',
      projection(action({
        content: {
          ...action().content,
          actionType: 'shipping-delivery',
          category: undefined,
        },
      })),
    );

    expect(categorized.metadata).toMatchObject({ semanticType: 'travel' });
    expect(categorized.category).toBe('social');
    expect(legacy.metadata).toMatchObject({ semanticType: 'shipping-delivery' });
    expect(legacy.category).toBe('packages');
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
