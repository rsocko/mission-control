import { describe, expect, it } from 'vitest';
import {
  tagMutationBusyReducer,
  type TagMutationBusyState,
} from '@/app/settings/components/tag-review/mutation-state';

describe('tag mutation busy state', () => {
  it('does not replace an active mutation with a simultaneous start', () => {
    const rename: TagMutationBusyState = {
      operation: 'rename',
      tagId: 'tag-1',
      token: 1,
    };
    const recolor: TagMutationBusyState = {
      operation: 'recolor',
      tagId: 'tag-2',
      token: 2,
    };

    const firstStarted = tagMutationBusyReducer(null, {
      type: 'start',
      mutation: rename,
    });
    const secondStarted = tagMutationBusyReducer(firstStarted, {
      type: 'start',
      mutation: recolor,
    });

    expect(secondStarted).toBe(firstStarted);
    expect(tagMutationBusyReducer(secondStarted, {
      type: 'finish',
      token: recolor.token,
    })).toBe(secondStarted);
    expect(tagMutationBusyReducer(secondStarted, {
      type: 'finish',
      token: rename.token,
    })).toBeNull();
  });

  it('blocks a conflicting same-operation start on another tag', () => {
    const older: TagMutationBusyState = {
      operation: 'rename',
      tagId: 'tag-1',
      token: 4,
    };
    const newer: TagMutationBusyState = {
      operation: 'rename',
      tagId: 'tag-2',
      token: 5,
    };
    const active = tagMutationBusyReducer(older, { type: 'start', mutation: newer });

    expect(active).toBe(older);
    expect(tagMutationBusyReducer(active, {
      type: 'finish',
      token: newer.token,
    })).toBe(older);
  });
});
