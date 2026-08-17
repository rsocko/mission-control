'use client';

import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Link2, Loader2, Merge, Trash2 } from 'lucide-react';
import { getTagPillStyle } from '@/lib/constants/colors';
import { modalContent, modalOverlay } from '@/lib/motion';
import { useCloseOnEscape } from '@/lib/hooks/useCloseOnEscape';
import type { TagDialogAction, TagDialogState } from '../dialog-state';
import { cannotUseAsMergeTarget, chooseDefaultMergeTarget } from '../heuristics';
import type { MergeMode, ReviewTag } from '../types';

const subscribePortalRoot = () => () => {};
const getPortalRoot = () => document.body;
const getServerPortalRoot = () => null;

interface MergeTagsDialogProps {
  busy: boolean;
  dispatch: React.Dispatch<TagDialogAction>;
  getSourceDetail: (tag: ReviewTag) => string;
  mode: MergeMode;
  onSubmit: (reviewTags: ReviewTag[], targetId: string, mode: MergeMode) => void;
  reviewTags: ReviewTag[];
  state: Extract<TagDialogState, { kind: 'merge' }> | null;
}

export function MergeTagsDialog({
  busy,
  dispatch,
  getSourceDetail,
  mode,
  onSubmit,
  reviewTags,
  state,
}: MergeTagsDialogProps) {
  const portalRoot = useSyncExternalStore(
    subscribePortalRoot,
    getPortalRoot,
    getServerPortalRoot,
  );
  const close = () => dispatch({ type: 'close' });
  useCloseOnEscape(close, !!state);
  const targetTag = state
    ? reviewTags.find(tag => tag.id === state.targetId) ?? null
    : null;
  const recommendedTargetId = reviewTags.length > 0
    ? chooseDefaultMergeTarget(reviewTags).id
    : null;
  const hasSourceTags = reviewTags.some(tag => tag.type === 'source');

  if (!portalRoot) return null;

  return createPortal(
    <AnimatePresence>
      {state && (
        <>
          <motion.div
            variants={modalOverlay}
            initial="hidden"
            animate="show"
            exit="exit"
            className="fixed inset-0 bg-black/60 z-50"
            onClick={close}
          />
          <motion.div
            variants={modalContent}
            initial="hidden"
            animate="show"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-labelledby="merge-dialog-title"
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-5 shadow-xl"
          >
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-400">
                Step {state.step} of 2
              </p>
              <p className="text-[10px] text-[var(--text-muted)]">{reviewTags.length} tags</p>
            </div>

            {state.step === 1 ? (
              <>
                <h3 id="merge-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                  Choose the tag to keep
                </h3>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                  Its name and color will represent the merged tags in Mission Control.
                </p>
                <div className="space-y-2 mb-4 max-h-48 overflow-y-auto pr-1">
                  {reviewTags.map(tag => {
                    const cannotUse = cannotUseAsMergeTarget(tag, reviewTags);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        disabled={cannotUse}
                        onClick={() => dispatch({ type: 'set-merge-target', targetId: tag.id })}
                        className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                          state.targetId === tag.id
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50'
                        }`}
                        aria-pressed={state.targetId === tag.id}
                        title={cannotUse
                          ? 'The selected source tags have no task scope to detach from'
                          : undefined}
                      >
                        <span className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                          state.targetId === tag.id ? 'border-blue-400' : 'border-[var(--text-muted)]'
                        }`}>
                          {state.targetId === tag.id && <span className="w-2 h-2 rounded-full bg-blue-400" />}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border border-[var(--border)]" style={getTagPillStyle(tag.color)}>
                              {tag.name}
                            </span>
                            {tag.id === recommendedTargetId && (
                              <span className="text-[9px] uppercase tracking-wide text-blue-400">Recommended</span>
                            )}
                          </span>
                          <span className="mt-1 block text-[10px] text-[var(--text-muted)]">
                            {getSourceDetail(tag)} · {tag.usageCount} task{tag.usageCount === 1 ? '' : 's'}
                          </span>
                          {cannotUse && (
                            <span className="mt-1 block text-[10px] text-amber-400">
                              Cannot keep this source tag because no selected source has a known task scope.
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="rounded-lg border border-blue-800/40 bg-blue-900/20 p-3 mb-4">
                  <span className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                    <Merge size={12} /> Merge in Mission Control
                  </span>
                  <span className="mt-1 block text-[10px] text-[var(--text-muted)]">
                    {hasSourceTags
                      ? targetTag?.type === 'source'
                        ? 'On tasks using the selected source tags, duplicate Hub assignments will be detached. The Hub tag remains unchanged everywhere else.'
                        : 'The tags will appear as one in Mission Control. Source labels stay unchanged so sync keeps working.'
                      : 'Tasks will move to the tag you keep, and the other local tag records will be deleted.'}
                  </span>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={close} className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!targetTag}
                    onClick={() => dispatch({ type: 'set-merge-step', step: 2 })}
                    className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Review Outcome
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 id="merge-dialog-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                  Review the outcome
                </h3>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                  Confirm exactly what will change before applying this action.
                </p>
                {targetTag && (
                  <div className="rounded-lg border border-blue-800/40 bg-blue-900/20 p-3 mb-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-400 mb-2">
                      What wins in Mission Control
                    </p>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 size={13} className="text-emerald-400" />
                      <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border border-[var(--border)]" style={getTagPillStyle(targetTag.color)}>
                        {targetTag.name}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)]">{getSourceDetail(targetTag)}</span>
                    </div>
                    <p className="mt-2 text-[10px] text-blue-300/80">
                      Its name and color represent all selected tags in Mission Control.
                    </p>
                  </div>
                )}
                <div className="rounded-lg bg-[var(--surface-0)] p-3 mb-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-2">
                    Tag-by-tag outcome
                  </p>
                  <ul className="space-y-2">
                    {reviewTags.map(tag => {
                      const isTarget = tag.id === state.targetId;
                      let outcome: string;
                      if (mode === 'unify') {
                        if (isTarget) {
                          outcome = tag.type === 'source'
                            ? ` remains unchanged in ${getSourceDetail(tag)} and becomes the winning tag in Mission Control.`
                            : ' is kept as the winning Mission Control tag.';
                        } else {
                          outcome = tag.type === 'source'
                            ? ` remains unchanged in ${getSourceDetail(tag)} and links to the winning tag in Mission Control.`
                            : targetTag?.type === 'source'
                              ? ' is detached only from tasks using the selected source tags and remains unchanged elsewhere.'
                              : ' is removed from Mission Control and its task assignments move to the winning tag.';
                        }
                      } else {
                        outcome = isTarget
                          ? ' is kept as the winning Mission Control tag.'
                          : ' is removed from Mission Control and its task assignments move to the winning tag.';
                      }
                      return (
                        <li key={tag.id} className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                          {isTarget
                            ? <CheckCircle2 size={11} className="mt-0.5 text-emerald-400 flex-shrink-0" />
                            : mode === 'unify'
                              ? <Link2 size={11} className="mt-0.5 text-blue-400 flex-shrink-0" />
                              : <Trash2 size={11} className="mt-0.5 text-red-400 flex-shrink-0" />}
                          <span>
                            <strong className="text-[var(--text-primary)]">{tag.name}</strong>
                            {outcome}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => dispatch({ type: 'set-merge-step', step: 1 })} className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={!state.targetId || busy}
                    onClick={() => onSubmit(reviewTags, state.targetId, mode)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Merge size={12} />}
                    Merge Tags
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    portalRoot,
  );
}
