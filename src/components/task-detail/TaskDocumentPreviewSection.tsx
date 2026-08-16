'use client';

import { ExternalLink, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskDetailMetadata, TaskDetailMode } from './task-detail-types';

export interface TaskDocumentPreviewSectionProps {
  mode: TaskDetailMode;
  /** Connector type, which selects the document-intelligence layout. */
  connectorType: string;
  /** Parsed task metadata; nothing renders without a preview URL. */
  metadata: TaskDetailMetadata;
}

/** Document preview — enhanced for document-intelligence, generic for others. */
export function TaskDocumentPreviewSection({
  mode,
  connectorType,
  metadata,
}: TaskDocumentPreviewSectionProps) {
  if (!metadata.previewUrl) return null;

  return (
    <div className={cn(
      'border-t border-[var(--border-subtle)] pt-3',
      (mode === 'panel' || mode === 'mobile') && 'order-7',
      mode === 'dialog' && 'col-start-2 row-start-6',
      mode === 'workspace' && 'col-start-2 row-start-6',
    )}>
      <div className="flex items-center gap-2 mb-2">
        <FileText size={13} className="text-[var(--text-muted)]" />
        <span className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Document</span>
      </div>

      {connectorType === 'document-intelligence' ? (
        <>
          {/* Document-oriented preview with metadata grid */}
          <div className="rounded-lg bg-[var(--surface-2)] border border-[var(--border)] overflow-hidden">
            {/* Preview header with link */}
            <a
              href={metadata.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-subtle)] hover:bg-[var(--surface-3)]/50 transition-colors duration-100 group/preview"
            >
              <div className="w-8 h-10 rounded bg-[var(--surface-3)] flex items-center justify-center flex-shrink-0">
                <FileText size={14} className="text-[var(--text-muted)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                  {metadata.documentTitle || 'Document'}
                </p>
                <p className="text-[10px] text-[var(--accent)] group-hover/preview:underline">
                  {metadata.previewLabel || 'Open in Paperless'}
                </p>
              </div>
              <ExternalLink size={12} className="text-[var(--accent)] flex-shrink-0" />
            </a>

            {/* Structured metadata grid */}
            <div className="px-3 py-2 space-y-1.5">
              {metadata.correspondent && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Correspondent</span>
                  <span className="text-xs text-[var(--text-secondary)] font-medium">{metadata.correspondent}</span>
                </div>
              )}
              {typeof metadata.amount === 'number' && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Amount</span>
                  <span className="text-xs text-emerald-400 font-semibold tabular-nums">${metadata.amount.toFixed(2)}</span>
                </div>
              )}
              {metadata.actionType && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Action</span>
                  <span className="text-xs text-[var(--text-secondary)] capitalize">{metadata.actionType}</span>
                </div>
              )}
              {metadata.urgency && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Urgency</span>
                  <span className={cn(
                    'text-[10px] font-medium px-1.5 py-0.5 rounded border capitalize',
                    metadata.urgency === 'critical' ? 'text-rose-400 bg-rose-400/10 border-rose-400/30' :
                    metadata.urgency === 'high' ? 'text-orange-400 bg-orange-400/10 border-orange-400/30' :
                    metadata.urgency === 'medium' ? 'text-amber-300 bg-amber-300/10 border-amber-300/30' :
                    'text-sky-400 bg-sky-400/10 border-sky-400/30'
                  )}>
                    {metadata.urgency}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 mt-2.5">
            <a
              href={metadata.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-3)]/80 transition-colors duration-100"
            >
              <ExternalLink size={10} />
              Open Doc
            </a>
          </div>

          {/* Open in OWL */}
          {metadata.docHubUrl && (
            <a
              href={metadata.docHubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 w-full mt-2 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 transition-colors duration-100"
            >
              <ExternalLink size={10} />
              Open in OWL
            </a>
          )}
        </>
      ) : (
        <>
          {/* Generic preview for non-DI connectors */}
          <a
            href={metadata.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--surface-2)]/80 transition-colors duration-150 group/preview"
          >
            <ExternalLink size={14} className="text-[var(--accent)] flex-shrink-0" />
            <span className="text-xs text-[var(--accent)] group-hover/preview:underline truncate">
              {metadata.previewLabel || 'Open Document'}
            </span>
          </a>
          {metadata.correspondent && (
            <p className="text-xs text-[var(--text-muted)] mt-1.5">
              {metadata.correspondent}
              {typeof metadata.amount === 'number' && (
                <span className="ml-2 font-medium text-[var(--text-secondary)]">
                  ${metadata.amount.toFixed(2)}
                </span>
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
