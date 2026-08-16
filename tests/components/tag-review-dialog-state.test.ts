import { describe, expect, it } from 'vitest';
import {
  CLOSED_TAG_DIALOG,
  tagDialogReducer,
} from '@/app/settings/components/tag-review/dialog-state';
import type { ReviewTag } from '@/app/settings/components/tag-review/types';

const tag: ReviewTag = {
  id: 'tag-1',
  name: 'Bug',
  slug: 'bug',
  type: 'hub',
  source: null,
  sources: [],
  sourceNames: [],
  color: '#ef4444',
  confirmed: true,
  usageCount: 2,
  unifiedInto: null,
  listUsage: [],
  sourceUsage: [],
};

describe('tag dialog workflow state', () => {
  it('replaces the active workflow instead of allowing dialogs to collide', () => {
    const rename = tagDialogReducer(CLOSED_TAG_DIALOG, { type: 'open-rename', tag });
    expect(rename).toEqual({ kind: 'rename', tag, value: 'Bug', revision: 1 });

    const deleteState = tagDialogReducer(rename, { type: 'open-delete', tag });
    expect(deleteState).toEqual({ kind: 'delete', tag, writeBack: false, revision: 2 });
    expect(deleteState.kind).not.toBe('rename');
  });

  it('keeps updates scoped to the active workflow', () => {
    const rename = tagDialogReducer(CLOSED_TAG_DIALOG, { type: 'open-rename', tag });
    expect(tagDialogReducer(rename, { type: 'set-write-back', value: true })).toBe(rename);
    expect(tagDialogReducer(rename, { type: 'set-value', value: 'Defect' })).toMatchObject({
      kind: 'rename',
      value: 'Defect',
    });
  });

  it('resets merge progress when a workflow closes or reopens', () => {
    const merge = tagDialogReducer(CLOSED_TAG_DIALOG, {
      type: 'open-merge',
      tagIds: ['tag-1', 'tag-2'],
      targetId: 'tag-1',
      origin: 'selection',
    });
    const reviewed = tagDialogReducer(merge, { type: 'set-merge-step', step: 2 });
    expect(reviewed).toMatchObject({ kind: 'merge', step: 2 });
    expect(tagDialogReducer(reviewed, { type: 'close' })).toEqual({
      kind: 'closed',
      revision: 1,
    });

    const reopened = tagDialogReducer(reviewed, {
      type: 'open-merge',
      tagIds: ['tag-2', 'tag-3'],
      targetId: 'tag-3',
      origin: 'suggestion',
    });
    expect(reopened).toMatchObject({
      kind: 'merge',
      step: 1,
      targetId: 'tag-3',
      origin: 'suggestion',
      revision: 2,
    });
  });

  it('ignores a stale completion after a newer workflow opens', () => {
    const rename = tagDialogReducer(CLOSED_TAG_DIALOG, { type: 'open-rename', tag });
    const closed = tagDialogReducer(rename, { type: 'close' });
    const recolor = tagDialogReducer(closed, { type: 'open-recolor', tag });

    expect(tagDialogReducer(recolor, {
      type: 'close',
      expectedRevision: rename.revision,
    })).toBe(recolor);
  });

  it('ignores updates from an unrelated workflow after switching dialogs', () => {
    const rename = tagDialogReducer(CLOSED_TAG_DIALOG, { type: 'open-rename', tag });
    const push = tagDialogReducer(rename, { type: 'open-push', tag });

    expect(tagDialogReducer(push, {
      type: 'set-value',
      value: 'Stale rename',
    })).toBe(push);
    expect(tagDialogReducer(push, {
      type: 'set-merge-step',
      step: 2,
    })).toBe(push);
    expect(tagDialogReducer(push, {
      type: 'set-push-target',
      targetListId: 'list-2',
    })).toMatchObject({
      kind: 'push',
      targetListId: 'list-2',
      revision: push.revision,
    });
  });
});
