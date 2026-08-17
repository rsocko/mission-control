'use client';

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  ChartNetwork,
  ChevronDown,
  ChevronRight,
  Code,
  Eye,
  FileText,
  GitBranch,
  Layers,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Tag,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fadeSlideUp } from '@/lib/motion';
import { SummaryCard } from './SummaryCard';
import type { Finding, PreviewData, ProjectMode } from './types';

export interface IntakePreviewStepProps {
  preview: PreviewData;
  document: string;
  documentUrl: string;

  reprocessing: boolean;
  /** Re-previews using the given document text. Resolves true on success. */
  onReprocess: (documentText: string) => Promise<boolean>;

  selectedFindingIds: Set<string>;
  onToggleFinding: (findingId: string, included: boolean) => void;
  editableTags: string[];
  onEditableTagsChange: Dispatch<SetStateAction<string[]>>;

  error: string | null;
  repo: string;
  projectMode: ProjectMode;
  selectedProjectId: string;

  onBack: () => void;
  onExecute: () => void;
}

/**
 * Step 2: analysis review + source inspection/editing.
 *
 * Owns all of its own presentation-only state (tab selection, phase
 * expansion, the edit buffer, the "add tag" input). Finding selection and
 * tags are lifted to `useDocumentIntake` since they're consumed by the
 * execute request too.
 */
export function IntakePreviewStep({
  preview,
  document,
  documentUrl,
  reprocessing,
  onReprocess,
  selectedFindingIds,
  onToggleFinding,
  editableTags,
  onEditableTagsChange,
  error,
  repo,
  projectMode,
  selectedProjectId,
  onBack,
  onExecute,
}: IntakePreviewStepProps) {
  const [previewTab, setPreviewTab] = useState<'analysis' | 'source'>('analysis');
  const [sourceView, setSourceView] = useState<'rendered' | 'raw' | 'edit'>('rendered');
  const [editBuffer, setEditBuffer] = useState('');
  const [expandedPhases, setExpandedPhases] = useState<Set<number>>(new Set());
  const [newTag, setNewTag] = useState('');

  const selectedFindingCount = useMemo(
    () => preview.document.findings.filter((f) => selectedFindingIds.has(f.id)).length,
    [preview, selectedFindingIds],
  );

  const skippedFindingCount = preview.document.findings.length - selectedFindingCount;

  async function handleReprocessClick() {
    if (!editBuffer.trim()) return;
    const success = await onReprocess(editBuffer);
    if (success) {
      setSourceView('rendered');
      setNewTag('');
    }
  }

  function addTag(rawTag: string) {
    const tag = rawTag.trim();
    if (!tag) return;
    onEditableTagsChange((prev) => {
      if (prev.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return prev;
      return [...prev, tag];
    });
    setNewTag('');
  }

  return (
    <motion.div variants={fadeSlideUp} initial="hidden" animate="show" exit="hidden" className="space-y-4">
      {/* Preview Tab Bar */}
      <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-1 w-fit shrink-0">
        <button
          onClick={() => setPreviewTab('analysis')}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs rounded transition-colors ${
            previewTab === 'analysis'
              ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          <Eye className="w-3.5 h-3.5" />
          Analysis
        </button>
        <button
          onClick={() => setPreviewTab('source')}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs rounded transition-colors ${
            previewTab === 'source'
              ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          <Code className="w-3.5 h-3.5" />
          View Source Document
        </button>
      </div>

      {previewTab === 'source' ? (
        /* Source Document View */
        <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
          {/* Source sub-toggle */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1 bg-[var(--surface-1)] rounded-md p-1">
              {([
                { key: 'rendered' as const, label: 'Rendered' },
                { key: 'raw' as const, label: 'Raw' },
              ]).map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setSourceView(key)}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    sourceView === key
                      ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                if (sourceView === 'edit') {
                  setSourceView('rendered');
                } else {
                  setEditBuffer(document);
                  setSourceView('edit');
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition-colors ${
                sourceView === 'edit'
                  ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
              }`}
            >
              <Pencil className="w-3.5 h-3.5" />
              {sourceView === 'edit' ? 'Editing' : 'Edit'}
            </button>
          </div>

          {/* Source content */}
          {sourceView === 'edit' ? (
            <div className="space-y-3">
              <textarea
                value={editBuffer}
                onChange={(e) => setEditBuffer(e.target.value)}
                className="w-full h-[40vh] bg-[var(--surface-1)] border border-[var(--border)] rounded-md p-4 text-sm font-mono text-[var(--text-secondary)] resize-none outline-none"
                placeholder="Edit document content..."
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleReprocessClick}
                  disabled={reprocessing || !editBuffer.trim()}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-[var(--accent-500)]/20 text-[var(--accent-400)] rounded-md hover:bg-[var(--accent-500)]/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {reprocessing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RotateCcw className="w-4 h-4" />
                  )}
                  {reprocessing ? 'Reprocessing...' : 'Reprocess'}
                </button>
                <button
                  onClick={() => setSourceView('rendered')}
                  className="flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-muted)] rounded-md hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              </div>
            </div>
          ) : sourceView === 'raw' ? (
            <pre className="max-h-[40vh] overflow-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-md p-4 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words">
              {document || documentUrl ? document || '(Document loaded from URL — raw content not available locally)' : '(No document content)'}
            </pre>
          ) : (
            <div className="max-h-[40vh] overflow-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-md p-4 prose prose-invert prose-sm max-w-none">
              {document || documentUrl ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {document || '*(Document loaded from URL — raw content not available locally)*'}
                </ReactMarkdown>
              ) : (
                <p className="text-[var(--text-muted)] italic">No document content</p>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Analysis View */
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-4 gap-4">
            <SummaryCard
              icon={<FileText className="w-5 h-5 text-amber-400" />}
              label="Findings"
              value={selectedFindingCount}
              subtitle={(() => {
                const included = preview.document.findings.filter((f) => selectedFindingIds.has(f.id));
                const existing = included.filter((f) => f.linkedIssueNumbers && f.linkedIssueNumbers.length > 0).length;
                const newCount = selectedFindingCount - existing;
                if (existing === 0) return undefined;
                return `${existing} existing · ${newCount} new`;
              })()}
            />
            <SummaryCard
              icon={<Layers className="w-5 h-5 text-blue-400" />}
              label="Phases"
              value={preview.proposedPhases.length}
            />
            <SummaryCard
              icon={<Tag className="w-5 h-5 text-green-400" />}
              label="Tags"
              value={editableTags.length}
            />
            <SummaryCard
              icon={<ChartNetwork className="w-5 h-5 text-purple-400" />}
              label="Project"
              value={preview.proposedProjectName}
              isText
            />
          </div>

          {/* Priority Groups */}
          <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
            <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Priority Groups</h3>
            <div className="space-y-2">
              {preview.document.priorityGroups.map((group) => (
                <div key={group.order} className="flex items-center justify-between text-sm">
                  <span className="text-[var(--text-secondary)]">{group.label}</span>
                  <span className="text-[var(--text-muted)]">{group.findingIds.length} items</span>
                </div>
              ))}
            </div>
          </div>

          {/* Phases — Expandable */}
          <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
            <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Proposed Phases</h3>
            <div className="space-y-3">
              {preview.proposedPhases.map((phase) => {
                const isExpanded = expandedPhases.has(phase.sortOrder);
                const phaseFindings = phase.findingIds
                  .map((id) => preview.document.findings.find((f) => f.id === id))
                  .filter(Boolean) as Finding[];

                return (
                  <div key={phase.sortOrder} className="border border-[var(--border)] rounded-md">
                    <button
                      onClick={() => {
                        setExpandedPhases((prev) => {
                          const next = new Set(prev);
                          if (next.has(phase.sortOrder)) {
                            next.delete(phase.sortOrder);
                          } else {
                            next.add(phase.sortOrder);
                          }
                          return next;
                        });
                      }}
                      className="w-full p-3 flex items-center justify-between text-left hover:bg-[var(--surface-2)]/50 rounded-md transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                        )}
                        <span className="text-sm font-medium text-[var(--text-primary)]">{phase.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                        {phase.estimatedDays && <span>{phase.estimatedDays}d</span>}
                        <span>{phase.findingIds.length} items</span>
                      </div>
                    </button>

                    {/* Collapsed: show ID badges */}
                    {!isExpanded && phase.findingIds.length > 0 && (
                      <div className="px-3 pb-3 pt-0 flex flex-wrap gap-1">
                        {phase.findingIds.map((id) => {
                          const finding = preview.document.findings.find((f) => f.id === id);
                          const isExisting = finding?.linkedIssueNumbers && finding.linkedIssueNumbers.length > 0;
                          return (
                            <span
                              key={id}
                              className={`px-1.5 py-0.5 rounded text-xs ${
                                isExisting
                                  ? 'bg-purple-500/15 border border-purple-500/30 text-purple-300'
                                  : 'bg-[var(--surface-1)] text-[var(--text-muted)]'
                              }`}
                            >
                              {id}{isExisting ? ` → #${finding!.linkedIssueNumbers![0]}` : ''}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {/* Expanded: show finding details */}
                    {isExpanded && phaseFindings.length > 0 && (
                      <div className="px-3 pb-3 border-t border-[var(--border)]/50">
                        <table className="w-full text-xs mt-2">
                          <thead>
                            <tr className="text-[var(--text-muted)] border-b border-[var(--border)]/50">
                              <th className="text-left py-1.5 pr-2">ID</th>
                              <th className="text-left py-1.5 pr-2">Issue</th>
                              <th className="text-left py-1.5 pr-2">Status</th>
                              <th className="text-left py-1.5 pr-2">Priority</th>
                              <th className="text-left py-1.5">Tags</th>
                            </tr>
                          </thead>
                          <tbody>
                            {phaseFindings.map((f) => {
                              const isExisting = f.linkedIssueNumbers && f.linkedIssueNumbers.length > 0;
                              return (
                              <tr key={f.id} className="border-b border-[var(--border)]/30">
                                <td className="py-1.5 pr-2 font-mono text-[var(--accent-400)] whitespace-nowrap">{f.id}</td>
                                <td className="py-1.5 pr-2 text-[var(--text-secondary)]">{f.issue}</td>
                                <td className="py-1.5 pr-2 whitespace-nowrap">
                                  {isExisting ? (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-500/15 border border-purple-500/30 rounded text-[10px] text-purple-300 font-medium">
                                      <GitBranch className="w-2.5 h-2.5" />
                                      {f.linkedIssueNumbers!.map((n) => `#${n}`).join(', ')}
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-500/30 rounded text-[10px] text-emerald-300 font-medium">
                                      New
                                    </span>
                                  )}
                                </td>
                                <td className="py-1.5 pr-2 text-[var(--text-muted)] whitespace-nowrap">P{f.priorityOrder}</td>
                                <td className="py-1.5">
                                  <div className="flex flex-wrap gap-1">
                                    <span className="px-1 py-0.5 bg-amber-500/10 rounded text-[10px] text-amber-300">Priority {f.priorityOrder}</span>
                                    <span className="px-1 py-0.5 bg-blue-500/10 rounded text-[10px] text-blue-300">Effort {f.effort}</span>
                                    <span className="px-1 py-0.5 bg-green-500/10 rounded text-[10px] text-green-300">Area: {f.area}</span>
                                  </div>
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tags */}
          <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
            <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Tags to Create (Editable)</h3>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {editableTags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[var(--accent-500)]/10 border border-[var(--accent-500)]/20 rounded text-xs text-[var(--accent-400)]">
                  {tag}
                  <button
                    type="button"
                    onClick={() => onEditableTagsChange((prev) => prev.filter((t) => t !== tag))}
                    className="text-[var(--accent-400)]/70 hover:text-[var(--accent-400)]"
                    aria-label={`Remove tag ${tag}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  addTag(newTag);
                }}
                className="w-full max-w-sm bg-[var(--surface-1)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none"
                placeholder="Add tag and press Enter"
              />
              <button
                type="button"
                onClick={() => addTag(newTag)}
                className="inline-flex items-center gap-1 px-2 py-1.5 text-xs bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] rounded text-[var(--text-primary)]"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
          </div>

          {/* Findings Table */}
          <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5 overflow-x-auto">
            <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">
              Findings ({selectedFindingCount} included{skippedFindingCount > 0 ? ` · ${skippedFindingCount} skipped` : ''})
            </h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="text-left py-2 pr-3">Include</th>
                  <th className="text-left py-2 pr-3">ID</th>
                  <th className="text-left py-2 pr-3">Area</th>
                  <th className="text-left py-2 pr-3">Issue</th>
                  <th className="text-left py-2 pr-3">Effort</th>
                  <th className="text-left py-2">Priority</th>
                </tr>
              </thead>
              <tbody>
                {preview.document.findings.map((f) => (
                  <tr key={f.id} className={`border-b border-[var(--border)]/50 ${selectedFindingIds.has(f.id) ? '' : 'opacity-50'}`}>
                    <td className="py-1.5 pr-3">
                      <input
                        type="checkbox"
                        checked={selectedFindingIds.has(f.id)}
                        onChange={(e) => onToggleFinding(f.id, e.target.checked)}
                        aria-label={`Include finding ${f.id}`}
                        className="h-3.5 w-3.5 rounded border-[var(--border)] bg-[var(--surface-1)] text-[var(--accent-500)] focus:ring-[var(--accent-500)]/60"
                      />
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[var(--accent-400)]">{f.id}</td>
                    <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{f.area}</td>
                    <td className="py-1.5 pr-3 text-[var(--text-muted)] max-w-xs truncate">{f.issue}</td>
                    <td className="py-1.5 pr-3 text-[var(--text-muted)]">{f.effort}</td>
                    <td className="py-1.5 text-[var(--text-muted)]">P{f.priorityOrder}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Actions — sticky at bottom */}
      <div className="sticky bottom-0 pt-4 pb-2 border-t border-[var(--border)] bg-[var(--surface-1)]/95 backdrop-blur-sm">
        <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] rounded-md text-sm font-medium transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={onExecute}
          disabled={!repo.trim() || selectedFindingCount === 0 || (projectMode === 'existing' && !selectedProjectId)}
          className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-500)] hover:bg-[var(--accent-600)] rounded-md text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play className="w-4 h-4" />
          Execute — {projectMode === 'existing' ? `Append ${selectedFindingCount} Tasks` : `Create ${selectedFindingCount} Tasks + Project`}
        </button>
        {!repo.trim() && (
          <span className="text-xs text-[var(--text-muted)]">Select a target repo above to execute</span>
        )}
        {projectMode === 'existing' && !selectedProjectId && repo.trim() && (
          <span className="text-xs text-[var(--text-muted)]">Select an existing project above to execute</span>
        )}
        {repo.trim() && selectedFindingCount === 0 && (
          <span className="text-xs text-[var(--text-muted)]">Select at least one finding to execute</span>
        )}
        </div>

        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm bg-red-950/30 border border-red-900/50 rounded-md p-3 mt-3">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}
      </div>
    </motion.div>
  );
}
