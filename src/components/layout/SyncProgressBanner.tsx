'use client';

import { AnimatePresence, motion } from 'motion/react';
import { RefreshCw } from 'lucide-react';
import type { SyncProgress } from '@/lib/hooks/useSyncStream';

interface SyncProgressBannerProps {
  progress: SyncProgress;
}

export function SyncProgressBanner({ progress }: SyncProgressBannerProps) {
  if (!progress.isSyncing) return null;

  const percent =
    progress.totalLists > 0
      ? Math.round((progress.listIndex / progress.totalLists) * 100)
      : 0;

  return (
    <AnimatePresence>
      {progress.isSyncing && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
          className="overflow-hidden"
        >
          <div className="bg-[var(--accent-900)]/30 border-b border-[var(--accent-800)]/40 px-4 sm:px-6 py-1.5">
            <div className="flex items-center gap-3 text-xs">
              {/* Spinning icon */}
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
              >
                <RefreshCw size={12} className="text-[var(--accent-400)]" />
              </motion.div>

              {/* Status text */}
              <span className="text-[var(--text-secondary)] truncate">
                {!progress.phase ? (
                  <>Starting sync…</>
                ) : progress.phase === 'push' ? (
                  <>Pushing local changes to {progress.connectorName || 'source'}…</>
                ) : (
                  <>
                    Syncing {progress.connectorName || 'source'}
                    {progress.currentList && (
                      <>
                        {' '}— <span className="text-[var(--text-primary)] font-medium">{progress.currentList}</span>
                      </>
                    )}
                    {progress.totalLists > 0 && (
                      <span className="text-[var(--text-tertiary)]">
                        {' '}({progress.listIndex}/{progress.totalLists} lists)
                      </span>
                    )}
                    {progress.totalTasks > 0 && (
                      <span className="text-[var(--text-tertiary)]">
                        {' '}• {progress.parentTasks.toLocaleString()} tasks
                        {progress.subtasks > 0 && (
                          <> + {progress.subtasks.toLocaleString()} subtasks</>
                        )}
                      </span>
                    )}
                    {progress.phase === 'lists' && progress.totalLists === 0 && (
                      <span className="text-[var(--text-tertiary)]"> — discovering lists…</span>
                    )}
                  </>
                )}
              </span>

              {/* Progress bar */}
              {progress.totalLists > 0 && (
                <div className="ml-auto w-24 h-1 rounded-full bg-[var(--surface-3)] overflow-hidden flex-shrink-0">
                  <motion.div
                    className="h-full bg-[var(--accent-400)] rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${percent}%` }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                  />
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
