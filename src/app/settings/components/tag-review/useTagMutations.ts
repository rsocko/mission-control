'use client';

import {
  useCallback,
  useReducer,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import {
  mapTagApiError,
  shouldRefreshAfter,
  tagReviewApi,
  TagApiError,
  type TagApiOperation,
} from './api';
import { isSystemTag } from './heuristics';
import { tagMutationBusyReducer } from './mutation-state';
import type { MergeMode, ReviewTag } from './types';

interface UseTagMutationsOptions {
  refreshTags: () => Promise<void>;
  setAllTags: Dispatch<SetStateAction<ReviewTag[]>>;
  removeSelectedIds: (tagIds: string[]) => void;
}

export function useTagMutations({
  refreshTags,
  setAllTags,
  removeSelectedIds,
}: UseTagMutationsOptions) {
  const [busy, dispatchBusy] = useReducer(tagMutationBusyReducer, null);
  const nextMutationToken = useRef(0);
  const activeMutationToken = useRef<number | null>(null);

  const beginMutation = useCallback((
    operation: TagApiOperation | 'bulk-delete',
    tagId?: string,
  ) => {
    if (activeMutationToken.current !== null) return null;
    const token = ++nextMutationToken.current;
    activeMutationToken.current = token;
    dispatchBusy({ type: 'start', mutation: { operation, tagId, token } });
    return token;
  }, []);

  const finishMutation = useCallback((token: number) => {
    if (activeMutationToken.current === token) activeMutationToken.current = null;
    dispatchBusy({ type: 'finish', token });
  }, []);

  const refreshFor = useCallback((operation: TagApiOperation) => {
    if (shouldRefreshAfter(operation)) void refreshTags();
  }, [refreshTags]);

  const confirm = useCallback(async (tagId: string) => {
    const token = beginMutation('confirm', tagId);
    if (token === null) return false;
    try {
      await tagReviewApi.patch('confirm', { id: tagId, confirmed: true });
      setAllTags(previous => previous.map(tag =>
        tag.id === tagId ? { ...tag, confirmed: true, type: 'hub' } : tag
      ));
      toast.success('Tag confirmed');
      return true;
    } catch (error) {
      toast.error(mapTagApiError('confirm', error));
      return false;
    } finally {
      finishMutation(token);
    }
  }, [beginMutation, finishMutation, setAllTags]);

  const dismiss = useCallback(async (tag: ReviewTag) => {
    const token = beginMutation('delete', tag.id);
    if (token === null) return false;
    try {
      await tagReviewApi.delete(tag.id);
      setAllTags(previous => previous.filter(item => item.id !== tag.id));
      removeSelectedIds([tag.id]);
      toast.success(`"${tag.name}" removed`);
      return true;
    } catch (error) {
      toast.error(mapTagApiError('delete', error));
      return false;
    } finally {
      finishMutation(token);
    }
  }, [beginMutation, finishMutation, removeSelectedIds, setAllTags]);

  const merge = useCallback(async (
    reviewTags: ReviewTag[],
    targetId: string,
    mode: MergeMode,
  ) => {
    if (!targetId || reviewTags.length < 2) return false;
    const token = beginMutation('merge');
    if (token === null) return false;
    try {
      const result = await tagReviewApi.merge(mode, reviewTags.map(tag => tag.id), targetId);
      if (mode === 'unify') {
        const effects = [
          `${result.linked} tasks linked`,
          result.detached > 0
            ? `${result.detached} duplicate Hub assignment${result.detached === 1 ? '' : 's'} detached`
            : null,
          result.removed > 0
            ? `${result.removed} local tag${result.removed === 1 ? '' : 's'} removed`
            : null,
        ].filter(Boolean);
        toast.success(
          `Merged ${result.unified} tag${result.unified === 1 ? '' : 's'} in Mission Control (${effects.join(', ')})`,
        );
      } else {
        toast.success(
          `Merged ${result.merged} tag${result.merged === 1 ? '' : 's'} (${result.reassigned} tasks reassigned)`,
        );
      }
      refreshFor('merge');
      return true;
    } catch (error) {
      toast.error(mapTagApiError('merge', error));
      return false;
    } finally {
      finishMutation(token);
    }
  }, [beginMutation, finishMutation, refreshFor]);

  const rename = useCallback(async (tag: ReviewTag, value: string) => {
    const name = value.trim();
    if (!name) return false;
    const token = beginMutation('rename', tag.id);
    if (token === null) return false;
    try {
      await tagReviewApi.patch('rename', { id: tag.id, name });
      setAllTags(previous => previous.map(item => item.id === tag.id ? {
        ...item,
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      } : item));
      toast.success(`Renamed to "${name}"`);
      return true;
    } catch (error) {
      toast.error(mapTagApiError('rename', error));
      return false;
    } finally {
      finishMutation(token);
    }
  }, [beginMutation, finishMutation, setAllTags]);

  const recolor = useCallback(async (tag: ReviewTag, color: string) => {
    if (!color) return false;
    const token = beginMutation('recolor', tag.id);
    if (token === null) return false;
    try {
      await tagReviewApi.patch('recolor', { id: tag.id, color });
      setAllTags(previous => previous.map(item =>
        item.id === tag.id ? { ...item, color } : item
      ));
      toast.success('Color updated');
      return true;
    } catch (error) {
      toast.error(mapTagApiError('recolor', error));
      return false;
    } finally {
      finishMutation(token);
    }
  }, [beginMutation, finishMutation, setAllTags]);

  const push = useCallback(async (tag: ReviewTag, sourceListId: string) => {
    if (!sourceListId) return false;
    const token = beginMutation('push', tag.id);
    if (token === null) return false;
    try {
      await tagReviewApi.push(tag.id, sourceListId);
      toast.success(`"${tag.name}" pushed to source`);
      refreshFor('push');
      return true;
    } catch (error) {
      toast.error(mapTagApiError('push', error));
      return false;
    } finally {
      finishMutation(token);
    }
  }, [beginMutation, finishMutation, refreshFor]);

  const remove = useCallback(async (tag: ReviewTag, writeBack: boolean) => {
    const token = beginMutation('delete', tag.id);
    if (token === null) return false;
    try {
      if (writeBack) {
        try {
          const result = await tagReviewApi.removeFromSource(tag.id);
          if (result.errors && result.errors.length > 0) {
            toast.warning(
              `Removed from ${result.removed} source task(s), but ${result.errors.length} failed`,
            );
          }
        } catch {
          toast.warning('Source removal failed — removing from Mission Control only');
        }
      }
      await tagReviewApi.delete(tag.id);
      setAllTags(previous => previous.filter(item => item.id !== tag.id));
      removeSelectedIds([tag.id]);
      toast.success(`"${tag.name}" removed`);
      return true;
    } catch (error) {
      toast.error(mapTagApiError('delete', error));
      return false;
    } finally {
      finishMutation(token);
    }
  }, [beginMutation, finishMutation, removeSelectedIds, setAllTags]);

  const removeBulk = useCallback(async (selectedTags: ReviewTag[], writeBack: boolean) => {
    const tags = selectedTags.filter(tag => !isSystemTag(tag.name));
    if (tags.length === 0) return false;
    const token = beginMutation('bulk-delete');
    if (token === null) return false;
    let successCount = 0;
    const deletedIds: string[] = [];
    try {
      if (writeBack) {
        for (const tag of tags) {
          try {
            await tagReviewApi.removeFromSource(tag.id);
          } catch {
            // Source cleanup remains best-effort for bulk removal.
          }
        }
      }

      for (const tag of tags) {
        try {
          await tagReviewApi.delete(tag.id);
          successCount++;
          deletedIds.push(tag.id);
        } catch (error) {
          if (!(error instanceof TagApiError) || error.status === undefined) throw error;
        }
      }

      if (deletedIds.length > 0) {
        setAllTags(previous => previous.filter(tag => !deletedIds.includes(tag.id)));
        removeSelectedIds(deletedIds);
      }
      if (successCount < tags.length) {
        toast.warning(`Removed ${successCount} of ${tags.length} tags (some failed)`);
      } else {
        toast.success(`Removed ${successCount} tag${successCount === 1 ? '' : 's'}`);
      }
      return true;
    } catch {
      toast.error('Failed to remove some tags');
      return false;
    } finally {
      finishMutation(token);
    }
  }, [beginMutation, finishMutation, removeSelectedIds, setAllTags]);

  return {
    busyOperation: busy?.operation ?? null,
    busyTagId: busy?.tagId ?? null,
    isBusy: busy !== null,
    confirm,
    dismiss,
    merge,
    push,
    recolor,
    remove,
    removeBulk,
    rename,
  };
}
