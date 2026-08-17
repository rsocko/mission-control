import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mapTagApiError,
  shouldRefreshAfter,
  tagReviewApi,
  TagApiError,
} from '@/app/settings/components/tag-review/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSuccess(body: object = { success: true }) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200 })
  ));
}

describe('tag review API workflows', () => {
  it.each([
    ['confirm', { id: 'tag-1', confirmed: true }],
    ['rename', { id: 'tag-1', name: 'Defect' }],
    ['recolor', { id: 'tag-1', color: '#ef4444' }],
  ] as const)('sends the %s mutation contract', async (operation, body) => {
    stubSuccess();
    await tagReviewApi.patch(operation, body);
    expect(fetch).toHaveBeenCalledWith('/api/tags', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify(body),
    }));
  });

  it('encodes delete identifiers', async () => {
    stubSuccess();
    await tagReviewApi.delete('tag/with spaces');
    expect(fetch).toHaveBeenCalledWith('/api/tags?id=tag%2Fwith%20spaces', { method: 'DELETE' });
  });

  it('keeps push and source-removal workflows independently addressable', async () => {
    stubSuccess();
    await tagReviewApi.push('tag-1', 'list-1');
    expect(fetch).toHaveBeenLastCalledWith('/api/tags/push', expect.objectContaining({
      body: JSON.stringify({ tagId: 'tag-1', sourceListId: 'list-1' }),
    }));

    await tagReviewApi.removeFromSource('tag-1');
    expect(fetch).toHaveBeenLastCalledWith('/api/tags/remove-from-source', expect.objectContaining({
      body: JSON.stringify({ tagId: 'tag-1' }),
    }));
  });

  it('maps API details only for workflows that previously surfaced them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Target is invalid' }), { status: 409 })
    ));

    const error = await tagReviewApi.merge('unify', ['a', 'b'], 'a').catch(value => value);
    expect(error).toBeInstanceOf(TagApiError);
    expect(mapTagApiError('merge', error)).toBe('Merge failed: Target is invalid');
    expect(mapTagApiError('rename', error)).toBe('Failed to rename tag');
  });

  it('centralizes refresh policy for server-reconciled mutations', () => {
    expect(shouldRefreshAfter('merge')).toBe(true);
    expect(shouldRefreshAfter('push')).toBe(true);
    expect(shouldRefreshAfter('rename')).toBe(false);
    expect(shouldRefreshAfter('recolor')).toBe(false);
    expect(shouldRefreshAfter('delete')).toBe(false);
  });
});
