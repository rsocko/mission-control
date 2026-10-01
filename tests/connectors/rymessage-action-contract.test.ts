import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isCompanionActionMutation,
  isCompanionActionV1,
  sanitizeCompanionAction,
  stableCompanionOperationId,
  type CompanionActionV1,
} from '@/lib/connectors/rymessage/action-contract';

const NOW = '2026-09-29T22:00:00.000Z';

function uuidFromDigest(namespace: string, value: string): string {
  const bytes = createHash('sha256')
    .update(`${namespace}\0`, 'utf8')
    .update(value, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

function canonicalAction(): CompanionActionV1 {
  const stableKey = `ak1:${'a'.repeat(64)}`;
  return {
    contractVersion: 1,
    actionId: uuidFromDigest('rymessage:action:v1', stableKey),
    stableKey,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    source: {
      identity: {
        kind: 'provider_message',
        provider: 'microsoft',
        id: 'private-message-id',
      },
      sourceKind: 'message',
      sourceFamily: 'm365',
      senderDisplayName: 'Private Sender',
      conversationTitle: 'Private Thread',
      messageExcerpt: 'Private excerpt',
      sourceUrl: 'https://example.test/private',
    },
    content: {
      title: 'Review the report',
      summary: 'Portable summary',
      actionType: 'follow-up',
      priority: 'high',
    },
    classification: {
      confidenceClass: 'high',
      confidenceScore: 0.9,
      reason: 'Private reasoning',
      derivationMethod: 'ai',
      model: 'private-model',
      inputFingerprint: 'b'.repeat(64),
      extractedPayload: { private: 'payload' },
    },
    lifecycle: {
      state: 'visible',
      feedback: [{
        feedbackId: '00000000-0000-4000-8000-000000000001',
        kind: 'confirmed',
        occurredAt: NOW,
      }],
    },
    fieldRevisions: {
      title: 1,
      lifecycle: 1,
    },
    materializations: [],
  };
}

describe('Companion ActionV1 contract', () => {
  it('accepts a canonical action and rejects identity, revision, and extension drift', () => {
    const action = canonicalAction();
    expect(isCompanionActionV1(action)).toBe(true);
    expect(isCompanionActionV1({ ...action, actionId: randomUUID() })).toBe(false);
    expect(isCompanionActionV1({
      ...action,
      fieldRevisions: { title: 0 },
    })).toBe(false);
    expect(isCompanionActionV1({
      ...action,
      source: {
        ...action.source,
        identity: { kind: 'provider_message', raw_response: 'forbidden' },
      },
    })).toBe(false);
    expect(isCompanionActionV1({ ...action, accountId: 'caller-supplied' })).toBe(false);
  });

  it('accepts only exact bounded integration mutations', () => {
    expect(isCompanionActionMutation({
      kind: 'action.user-edit',
      patch: {
        title: 'Bounded title',
        priority: 'critical',
        dueAt: NOW,
      },
    })).toBe(true);
    expect(isCompanionActionMutation({
      kind: 'action.user-edit',
      patch: { providerTaskId: 'forbidden' },
    })).toBe(false);
    expect(isCompanionActionMutation({
      kind: 'action.user-edit',
      patch: { priority: 'urgent' },
    })).toBe(false);
    expect(isCompanionActionMutation({
      kind: 'action.lifecycle',
      state: 'completed',
      providerTaskId: 'forbidden',
    })).toBe(false);
    expect(isCompanionActionMutation({
      kind: 'action.correction',
      correction: 'reclassified',
      correctedActionType: 'follow-up',
      accountId: 'forbidden',
    })).toBe(false);
    expect(isCompanionActionMutation({
      kind: 'materialization.link',
      materializationId: randomUUID(),
    })).toBe(false);
  });

  it('retains bounded presentation fields while removing raw identity and extracted data', () => {
    const portable = sanitizeCompanionAction(canonicalAction());
    const persisted = JSON.stringify(portable);
    for (const sensitive of [
      'private-message-id',
      'payload',
      'feedbackId',
    ]) {
      expect(persisted).not.toContain(sensitive);
    }
    expect(portable.source).toEqual({
      senderDisplayName: 'Private Sender',
      conversationTitle: 'Private Thread',
      messageExcerpt: 'Private excerpt',
      sourceUrl: 'https://example.test/private',
    });
    expect(portable.classification).toMatchObject({
      reason: 'Private reasoning',
      model: 'private-model',
    });
    const first = stableCompanionOperationId('same-observation');
    expect(stableCompanionOperationId('same-observation')).toBe(first);
    expect(stableCompanionOperationId('different-observation')).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
