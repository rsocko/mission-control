'use client';

import { ChevronRight, ChartNetwork, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DevelopProposal, GoalItem } from './types';

interface DevelopPanelProps {
  item: GoalItem | null;
  proposal: DevelopProposal | null;
  loading: boolean;
  promoting: boolean;
  onPromote: () => void;
  onClose: () => void;
}

export function DevelopPanel({
  item,
  proposal,
  loading,
  promoting,
  onPromote,
  onClose,
}: DevelopPanelProps) {
  return (
    <>
      <div className="p-4 border-b border-[var(--border-subtle)]">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-purple-500/10 rounded-full flex items-center justify-center">
              <Sparkles size={12} className="text-purple-400" />
            </div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">AI: Develop</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded-[var(--radius-sm)] hover:bg-[var(--surface-2)] transition-colors duration-150"
          >
            <X size={14} />
          </button>
        </div>
        {item && <p className="text-xs text-[var(--text-tertiary)] truncate">Expanding &ldquo;{item.title}&rdquo;</p>}
      </div>

      <div className="flex-1 p-4 space-y-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Loader2 size={20} className="animate-spin text-purple-400" />
            <p className="text-xs text-[var(--text-tertiary)]">Analyzing and developing...</p>
          </div>
        ) : proposal ? (
          <>
            <div className="bg-purple-500/10 border border-purple-500/20 rounded-[var(--radius-lg)] p-3">
              <p className="text-xs text-purple-300 leading-relaxed">{proposal.summary}</p>
            </div>

            {proposal.suggestedTasks.length > 0 && (
              <div>
                <h4 className="text-[12px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-2">
                  Suggested Tasks
                </h4>
                <div className="space-y-2">
                  {proposal.suggestedTasks.map((task, index) => (
                    <div
                      key={index}
                      className="border border-[var(--border-subtle)] rounded-[var(--radius-md)] p-2.5 hover:border-[var(--border-strong)] transition-colors duration-150"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-3.5 h-3.5 border-2 border-dashed border-blue-400/60 rounded flex items-center justify-center">
                          <Plus size={7} className="text-blue-400" />
                        </div>
                        <span className="text-xs font-medium text-[var(--text-primary)]">{task.title}</span>
                      </div>
                      {task.description && (
                        <p className="text-[12px] text-[var(--text-tertiary)] ml-[22px] leading-relaxed">
                          {task.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 ml-[22px]">
                        {task.effort && (
                          <span className="text-[9px] bg-[var(--surface-2)] text-[var(--text-tertiary)] px-1.5 py-0.5 rounded">
                            {task.effort}
                          </span>
                        )}
                        {task.category && (
                          <span className="text-[9px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded">
                            {task.category}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {proposal.suggestedProject && (
              <>
                <div>
                  <h4 className="text-[12px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-2">
                    Suggested Project Structure
                  </h4>
                  <div className="border border-blue-500/30 bg-blue-500/5 rounded-[var(--radius-md)] p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <ChartNetwork size={12} className="text-blue-400" />
                      <span className="text-xs font-medium text-blue-300">{proposal.suggestedProject.name}</span>
                      <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">new project</span>
                    </div>
                    <p className="text-[12px] text-blue-400/70 mb-2">
                      {proposal.suggestedProject.category && `${proposal.suggestedProject.category} · `}
                      Est. {proposal.suggestedProject.estimatedEffortDays} effort-days ·{' '}
                      {proposal.suggestedProject.phases.length} phases
                    </p>
                    <div className="space-y-1">
                      {proposal.suggestedProject.phases.map((phase, index) => (
                        <div key={index} className="flex items-center gap-1.5 text-[12px] text-blue-400/80">
                          <ChevronRight size={8} />
                          {phase.name} ({phase.taskIndices.length} tasks)
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-2 pt-2">
                  <Button onClick={onPromote} disabled={promoting} className="w-full text-xs" size="sm">
                    {promoting ? <Loader2 size={12} className="animate-spin" /> : <ChartNetwork size={12} />}
                    Create Project
                  </Button>
                  <p className="text-[12px] text-[var(--text-tertiary)] text-center">
                    Creates a project with phases — tasks are added automatically
                  </p>
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
