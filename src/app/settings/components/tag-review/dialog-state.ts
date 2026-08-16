import type { MergeOrigin, ReviewTag } from './types';

type TagDialogWorkflow =
  | { kind: 'closed' }
  | { kind: 'delete'; tag: ReviewTag; writeBack: boolean }
  | { kind: 'bulk-delete'; writeBack: boolean }
  | {
      kind: 'merge';
      tagIds: string[];
      targetId: string;
      origin: MergeOrigin;
      step: 1 | 2;
    }
  | { kind: 'rename'; tag: ReviewTag; value: string }
  | { kind: 'recolor'; tag: ReviewTag; value: string }
  | { kind: 'push'; tag: ReviewTag; targetListId: string };

export type TagDialogState = TagDialogWorkflow & { revision: number };

export type TagDialogAction =
  | { type: 'close'; expectedRevision?: number }
  | { type: 'open-delete'; tag: ReviewTag }
  | { type: 'open-bulk-delete' }
  | {
      type: 'open-merge';
      tagIds: string[];
      targetId: string;
      origin: MergeOrigin;
    }
  | { type: 'open-rename'; tag: ReviewTag }
  | { type: 'open-recolor'; tag: ReviewTag }
  | { type: 'open-push'; tag: ReviewTag }
  | { type: 'set-write-back'; value: boolean }
  | { type: 'set-value'; value: string }
  | { type: 'set-push-target'; targetListId: string }
  | { type: 'set-merge-target'; targetId: string }
  | { type: 'set-merge-step'; step: 1 | 2 };

export const CLOSED_TAG_DIALOG: TagDialogState = { kind: 'closed', revision: 0 };

export function tagDialogReducer(
  state: TagDialogState,
  action: TagDialogAction,
): TagDialogState {
  switch (action.type) {
    case 'close':
      if (
        action.expectedRevision !== undefined
        && action.expectedRevision !== state.revision
      ) return state;
      return { kind: 'closed', revision: state.revision };
    case 'open-delete':
      return {
        kind: 'delete',
        tag: action.tag,
        writeBack: false,
        revision: state.revision + 1,
      };
    case 'open-bulk-delete':
      return { kind: 'bulk-delete', writeBack: false, revision: state.revision + 1 };
    case 'open-merge':
      return {
        kind: 'merge',
        tagIds: action.tagIds,
        targetId: action.targetId,
        origin: action.origin,
        step: 1,
        revision: state.revision + 1,
      };
    case 'open-rename':
      return {
        kind: 'rename',
        tag: action.tag,
        value: action.tag.name,
        revision: state.revision + 1,
      };
    case 'open-recolor':
      return {
        kind: 'recolor',
        tag: action.tag,
        value: action.tag.color || '#6b7280',
        revision: state.revision + 1,
      };
    case 'open-push':
      return {
        kind: 'push',
        tag: action.tag,
        targetListId: '',
        revision: state.revision + 1,
      };
    case 'set-write-back':
      if (state.kind !== 'delete' && state.kind !== 'bulk-delete') return state;
      return { ...state, writeBack: action.value };
    case 'set-value':
      if (state.kind !== 'rename' && state.kind !== 'recolor') return state;
      return { ...state, value: action.value };
    case 'set-push-target':
      return state.kind === 'push' ? { ...state, targetListId: action.targetListId } : state;
    case 'set-merge-target':
      return state.kind === 'merge' ? { ...state, targetId: action.targetId } : state;
    case 'set-merge-step':
      return state.kind === 'merge' ? { ...state, step: action.step } : state;
  }
}
