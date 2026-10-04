import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  actionFeedSourceId,
  isActionV2,
  type ActionV2,
} from '@/lib/connectors/rymessage/action-contract';
import {
  isCompanionActionFeedPageV2,
  isCompanionActionMutationRequestV2,
  type CompanionActionFeedPageV2,
} from '@/lib/connectors/rymessage/action-contract-v2';

const FEED_ID = '10000000-0000-4000-8000-000000000001';
const EVENT_ID = '10000000-0000-4000-8000-000000000003';
const NOW = '2026-01-02T03:04:05.000Z';
const TRUSTED_ORIGINS = new Set([
  'https://mission-control.example',
  'https://github.com',
]);

function fixturePage(): CompanionActionFeedPageV2 {
  const fixture = JSON.parse(readFileSync(
    'tests/fixtures/rymessage-action-task-links/v2/feed-page.json',
    'utf8',
  )) as { upsertPage: unknown };
  return JSON.parse(JSON.stringify(fixture.upsertPage)
    .replaceAll('<feed-id>', FEED_ID)
    .replaceAll('<event-id>', EVENT_ID)
    .replaceAll('<timestamp>', NOW)
    .replaceAll('<opaque-cursor>', 'cursor:terminal')) as CompanionActionFeedPageV2;
}

describe('canonical RyMessage ActionV2 contract', () => {
  it('accepts the SHA-pinned producer fixture without compatibility adapters', () => {
    const page = fixturePage();
    expect(page.items[0]?.sourceId).toBe(actionFeedSourceId(
      FEED_ID,
      page.items[0]!.aggregateId,
    ));
    expect(isCompanionActionFeedPageV2(page, TRUSTED_ORIGINS)).toBe(true);
  });

  it('accepts rich Unicode and rejects prohibited control characters', () => {
    const page = fixturePage();
    const item = page.items[0]!;
    if (item.kind !== 'upsert') throw new Error('Expected upsert fixture');
    const unicodeAction: ActionV2 = {
      ...item.projection.action,
      content: {
        ...item.projection.action.content,
        title: '確認 👩🏽‍💻 café e\u0301 — مرحبًا',
        summary: '家庭計画 • Zażółć gęślą jaźń',
      },
      source: {
        ...item.projection.action.source,
        messageExcerpt: '“On it” ✅ — Second line',
      },
    };
    expect(isActionV2(unicodeAction)).toBe(true);
    expect(isActionV2({
      ...unicodeAction,
      content: { ...unicodeAction.content, title: 'bad\u0007title' },
    })).toBe(false);
    expect(isActionV2({
      ...unicodeAction,
      source: { ...unicodeAction.source, messageExcerpt: 'bad\u007fexcerpt' },
    })).toBe(false);
  });

  it('rejects the removed V1-style duplicate top-level action', () => {
    const page = fixturePage();
    const upsert = page.items[0]!;
    const legacy = {
      ...page,
      items: [{
        ...upsert,
        action: upsert.kind === 'upsert' ? upsert.projection.action : {},
      }],
    };
    expect(isCompanionActionFeedPageV2(legacy, TRUSTED_ORIGINS)).toBe(false);
  });

  it('fails closed without throwing on non-serializable page input', () => {
    const page = fixturePage() as CompanionActionFeedPageV2 & { items: unknown[] };
    page.items = [page];
    expect(() => isCompanionActionFeedPageV2(page, TRUSTED_ORIGINS)).not.toThrow();
    expect(isCompanionActionFeedPageV2(page, TRUSTED_ORIGINS)).toBe(false);
  });

  it('retains an incremental next cursor on the terminal full page', () => {
    const page = fixturePage();
    expect(page.mode).toBe('full');
    expect(page.complete).toBe(true);
    expect(page.nextCursor).toBe('cursor:terminal');
    expect(isCompanionActionFeedPageV2(page, TRUSTED_ORIGINS)).toBe(true);
  });

  it('validates canonical action-state and task-link mutation requests', () => {
    expect(isCompanionActionMutationRequestV2({
      contractVersion: '2.0',
      operationId: '10000000-0000-4000-8000-000000000010',
      actionId: '1a4026a4-5cc7-521a-ad0c-070c31c2600c',
      baseRevision: 2,
      mutation: { kind: 'action.lifecycle', state: 'handled' },
    }, TRUSTED_ORIGINS)).toBe(true);
    expect(isCompanionActionMutationRequestV2({
      contractVersion: '2.0',
      operationId: '10000000-0000-4000-8000-000000000011',
      actionId: '1a4026a4-5cc7-521a-ad0c-070c31c2600c',
      expectedRevision: 2,
      mutation: {
        kind: 'creation-intent.register',
        intentId: '10000000-0000-4000-8000-000000000012',
        draft: { title: '建立任務 🚀' },
      },
    }, TRUSTED_ORIGINS)).toBe(true);
  });
});
