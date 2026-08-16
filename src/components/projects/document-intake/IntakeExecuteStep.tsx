'use client';

import { motion } from 'motion/react';
import {
  AlertTriangle,
  ChartNetwork,
  CheckCircle2,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { fadeSlideUp } from '@/lib/motion';
import type { ExecuteResult } from './types';

export interface IntakeExecuteStepProps {
  /** 'executing' shows the in-flight spinner; 'done' shows the result summary. */
  phase: 'executing' | 'done';
  /** Required when `phase` is 'done'. Ignored while 'executing'. */
  result: ExecuteResult | null;
  onReset: () => void;
  onClose: () => void;
}

/**
 * Step 3: execution progress + result.
 *
 * Covers both the "executing" and "done" states of the workflow — they
 * share this component because "done" is simply the terminal render of the
 * same execute request, with no additional user input in between.
 */
export function IntakeExecuteStep({ phase, result, onReset, onClose }: IntakeExecuteStepProps) {
  if (phase === 'executing') {
    return (
      <motion.div variants={fadeSlideUp} initial="hidden" animate="show" exit="hidden" className="flex flex-col items-center justify-center py-20">
        <Loader2 className="w-10 h-10 text-[var(--accent-400)] animate-spin mb-4" />
        <p className="text-[var(--text-secondary)] text-lg">Creating tasks, project, and phases...</p>
        <p className="text-[var(--text-muted)] text-sm mt-1">Tasks sync to GitHub as issues. This may take a minute for large documents.</p>
      </motion.div>
    );
  }

  if (!result) return null;

  return (
    <motion.div variants={fadeSlideUp} initial="hidden" animate="show" exit="hidden" className="space-y-6">
      {/* Success banner */}
      <div className="bg-green-950/30 border border-green-800/50 rounded-lg p-4 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-green-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-green-200 font-medium">Intake Complete</p>
          <p className="text-green-400/70 text-sm mt-0.5">
            Processed {result.issues.length} finding{result.issues.length !== 1 ? 's' : ''},{' '}
            {result.phases.length} phase{result.phases.length !== 1 ? 's' : ''},{' '}
            {result.tags.length} tag{result.tags.length !== 1 ? 's' : ''}
            {result.issues.filter((i) => i.issueNumber).length > 0 && (
              <> · {result.issues.filter((i) => i.issueNumber).length} linked to GitHub</>
            )}
            {result.assignments.filter((a) => a.status === 'assigned').length > 0 &&
              result.issues.filter((i) => i.issueNumber).length === 0 && (
              <> · {result.assignments.filter((a) => a.status === 'assigned').length} tasks assigned</>
            )}
          </p>
        </div>
      </div>

      {/* Errors */}
      {result.errors.length > 0 && (
        <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-4">
          <h3 className="text-sm font-medium text-red-300 mb-2 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            {result.errors.length} Warning(s)
          </h3>
          <ul className="text-xs text-red-400/80 space-y-1">
            {result.errors.map((err, i) => (
              <li key={i}>• {err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Project link */}
      {result.projectId && (
        <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-4">
          <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-2">Project</h3>
          <a
            href={`/projects/${result.projectId}`}
            className="inline-flex items-center gap-2 text-[var(--accent-400)] hover:text-[var(--accent-300)] text-sm transition-colors"
          >
            <ChartNetwork className="w-4 h-4" />
            Open project →
          </a>
        </div>
      )}

      {/* Findings / Task Assignments */}
      <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5 overflow-x-auto">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Findings</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
              <th className="text-left py-2 pr-3">Finding</th>
              <th className="text-left py-2 pr-3">Issue</th>
              <th className="text-left py-2 pr-3">Phase</th>
              <th className="text-left py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {result.issues.map((issue) => {
              const assignment = result.assignments.find((a) => a.findingId === issue.findingId);
              return (
                <tr key={issue.findingId} className="border-b border-[var(--border)]/50">
                  <td className="py-1.5 pr-3 font-mono text-[var(--accent-400)]">{issue.findingId}</td>
                  <td className="py-1.5 pr-3">
                    {issue.htmlUrl ? (
                      <a href={issue.htmlUrl} target="_blank" rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">
                        #{issue.issueNumber} <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--text-muted)]">{assignment?.phaseName || '—'}</td>
                  <td className="py-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      assignment?.status === 'assigned' ? 'bg-green-500/10 text-green-400' :
                      assignment?.status === 'missing-task' ? 'bg-yellow-500/10 text-yellow-400' :
                      'bg-[var(--surface-2)] text-[var(--text-muted)]'
                    }`}>
                      {assignment?.status || 'pending'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={onReset}
          className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] rounded-md text-sm font-medium transition-colors"
        >
          Start New Intake
        </button>
        {result.projectId && (
          <a
            href={`/projects/${result.projectId}`}
            onClick={onClose}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-500)] hover:bg-[var(--accent-600)] rounded-md text-sm font-medium text-white transition-colors"
          >
            <ChartNetwork className="w-4 h-4" />
            View Project
          </a>
        )}
      </div>
    </motion.div>
  );
}
