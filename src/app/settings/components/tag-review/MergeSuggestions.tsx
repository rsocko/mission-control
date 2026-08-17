'use client';

import { ChevronDown, Zap } from 'lucide-react';
import { motion } from 'motion/react';
import { getTagPillStyle } from '@/lib/constants/colors';
import { fadeSlideUp } from '@/lib/motion';
import { ConnectorBrandIcon } from '../ConnectorBrandIcon';
import type { ReviewTag } from './types';

interface MergeSuggestionsProps {
  getSourceDetail: (tag: ReviewTag) => string;
  getSourceIcon: (tag: ReviewTag) => string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onReview: (a: ReviewTag, b: ReviewTag) => void;
  suggestions: Array<{ a: ReviewTag; b: ReviewTag }>;
}

export function MergeSuggestions({
  getSourceDetail,
  getSourceIcon,
  expanded,
  onExpandedChange,
  onReview,
  suggestions,
}: MergeSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <motion.div variants={fadeSlideUp} className="bg-amber-900/20 border border-amber-800/30 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-full bg-amber-900/40 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Zap size={13} className="text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => onExpandedChange(!expanded)}
            aria-expanded={expanded}
            aria-controls="tag-merge-suggestions"
            className="flex w-full items-start justify-between gap-3 text-left"
          >
            <span>
              <span className="block text-sm font-medium text-amber-300">
                {suggestions.length} potential duplicate{suggestions.length > 1 ? 's' : ''} found
              </span>
              <span className="mt-0.5 block text-[11px] text-amber-300/70">
                Review a suggestion before any tags or task assignments change.
              </span>
            </span>
            <ChevronDown
              size={15}
              className={`mt-0.5 flex-shrink-0 text-amber-400 transition-transform ${expanded ? '' : '-rotate-90'}`}
            />
          </button>
          {expanded && (
            <div id="tag-merge-suggestions" className="mt-2 space-y-1.5">
              {suggestions.slice(0, 3).map(({ a, b }) => (
                <div key={`${a.id}:${b.id}`} className="flex flex-wrap items-center gap-2 text-xs text-amber-300/80">
                  {[a, b].map((tag, index) => (
                    <span key={tag.id} className="contents">
                      {index > 0 && <span className="text-[var(--text-muted)]">≈</span>}
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-amber-800/30" style={getTagPillStyle(tag.color)}>
                          {tag.name}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]" title={getSourceDetail(tag)}>
                          {getSourceIcon(tag) && <ConnectorBrandIcon type={getSourceIcon(tag)!} size={10} />}
                          {getSourceDetail(tag)}
                        </span>
                      </span>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => onReview(a, b)}
                    className="text-amber-400 hover:text-amber-300 underline underline-offset-2"
                  >
                    Review
                  </button>
                </div>
              ))}
              {suggestions.length > 3 && (
                <p className="text-[10px] text-amber-300/60">
                  And {suggestions.length - 3} more suggestions in the tag list below.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
