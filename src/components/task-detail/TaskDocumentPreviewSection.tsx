'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, Maximize2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { buildPaperlessPreviewUrl } from '@/lib/connectors/document-intelligence/preview-url';
import { cn } from '@/lib/utils';
import { parseLocalDate } from '@/lib/utils/date-format';
import type { TaskDetailMetadata, TaskDetailMode } from './task-detail-types';

export interface TaskDocumentPreviewSectionProps {
  mode: TaskDetailMode;
  connectorType: string;
  metadata: TaskDetailMetadata;
  dueDate?: string | null;
  className?: string;
  fillAvailableSpace?: boolean;
}

function normalizePreviewUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function DocumentPreview({
  url,
  title,
  type,
  expanded,
  fillAvailableSpace,
}: {
  url: string;
  title: string;
  type: TaskDetailMetadata['previewType'];
  expanded?: boolean;
  fillAvailableSpace?: boolean;
}) {
  if (type === 'image') {
    return (
      // The source is connector-provided and may not be accepted by Next Image's host allowlist.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={`Preview of ${title}`}
        className={cn(
          'h-full w-full bg-black/20 object-contain',
          expanded ? 'min-h-[70vh]' : fillAvailableSpace ? 'min-h-[60vh]' : 'min-h-64',
        )}
      />
    );
  }

  const sameOrigin = typeof window !== 'undefined' && new URL(url).origin === window.location.origin;

  return (
    <iframe
      src={url}
      title={`Preview of ${title}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      sandbox={sameOrigin
        ? 'allow-forms allow-popups allow-scripts'
        : 'allow-forms allow-popups allow-same-origin allow-scripts'}
      className={cn(
        'w-full border-0 bg-white',
        expanded ? 'h-full min-h-[70vh]' : fillAvailableSpace ? 'h-[70vh] min-h-[32rem]' : 'h-72',
      )}
    />
  );
}

function DocumentPreviewPlaceholder({ title, fillAvailableSpace }: { title: string; fillAvailableSpace?: boolean }) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center bg-[var(--surface-0)] px-6 text-center',
      fillAvailableSpace ? 'min-h-[32rem]' : 'h-52',
    )}>
      <div className="mb-3 flex h-14 w-11 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] shadow-lg">
        <FileText size={20} className="text-indigo-300" />
      </div>
      <p className="text-xs font-medium text-[var(--text-secondary)]">{title}</p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-[var(--text-muted)]">
        This source does not expose an embeddable preview. Open the original document to review it.
      </p>
    </div>
  );
}

export function TaskDocumentPreviewSection({
  mode,
  connectorType,
  metadata,
  dueDate,
  className,
  fillAvailableSpace = false,
}: TaskDocumentPreviewSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const isDocumentIntelligence = connectorType === 'document-intelligence';
  const suppliedPreviewUrl = normalizePreviewUrl(metadata.previewUrl);
  const documentUrl = normalizePreviewUrl(metadata.documentUrl);
  const legacyPaperlessPreviewUrl = isDocumentIntelligence
    && metadata.previewType === 'external'
    && metadata.documentId != null
    && documentUrl != null
    && suppliedPreviewUrl === documentUrl
    ? normalizePreviewUrl(buildPaperlessPreviewUrl(
        documentUrl,
        metadata.documentId,
      ))
    : null;
  const previewUrl = legacyPaperlessPreviewUrl || suppliedPreviewUrl;
  if (!previewUrl) return null;
  const originalUrl = documentUrl || suppliedPreviewUrl || previewUrl;

  const title = metadata.documentTitle || 'Document';
  const previewType = legacyPaperlessPreviewUrl ? 'pdf' : metadata.previewType;
  const canEmbed = previewType === 'pdf'
    || previewType === 'iframe'
    || previewType === 'image';
  const formattedDueDate = dueDate
    ? parseLocalDate(dueDate)?.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className={cn(
      'border-t border-[var(--border-subtle)] pt-3',
      (mode === 'panel' || mode === 'mobile') && 'order-7',
      mode === 'dialog' && 'col-start-2 row-start-6',
      mode === 'workspace' && 'col-start-2 row-start-6',
      fillAvailableSpace && 'border-t-0 pt-0',
      className,
    )}>
      <div className="mb-2 flex items-center gap-2">
        <FileText size={13} className="text-[var(--text-muted)]" />
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Document</span>
      </div>

      {isDocumentIntelligence ? (
        <>
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
            <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5">
              <div className="flex h-10 w-8 shrink-0 items-center justify-center rounded bg-[var(--surface-3)]">
                <FileText size={14} className="text-indigo-300" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-[var(--text-primary)]">{title}</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {metadata.documentType || 'Paperless-ngx document'}
                </p>
              </div>
              {canEmbed && (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-2 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  aria-label="Expand document preview"
                >
                  <Maximize2 size={12} />
                  <span className="hidden xl:inline">Expand</span>
                </button>
              )}
            </div>

            <div className="relative overflow-hidden border-b border-[var(--border-subtle)] bg-[var(--surface-0)]">
              {canEmbed ? (
                <>
                  <DocumentPreview
                    url={previewUrl}
                    title={title}
                    type={previewType}
                    fillAvailableSpace={fillAvailableSpace}
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/20 to-transparent" />
                </>
              ) : (
                <DocumentPreviewPlaceholder title={title} fillAvailableSpace={fillAvailableSpace} />
              )}
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-3">
              {metadata.correspondent && (
                <MetadataItem label="Correspondent" value={metadata.correspondent} />
              )}
              {typeof metadata.amount === 'number' && (
                <MetadataItem label="Amount" value={`$${metadata.amount.toFixed(2)}`} accent />
              )}
              {metadata.actionType && (
                <MetadataItem label="Action" value={metadata.actionType} capitalize />
              )}
              {metadata.urgency && (
                <MetadataItem label="Urgency" value={metadata.urgency} capitalize />
              )}
              {formattedDueDate && (
                <MetadataItem label="Due date" value={formattedDueDate} />
              )}
              {metadata.documentId != null && (
                <MetadataItem label="Document ID" value={String(metadata.documentId)} />
              )}
            </dl>
          </div>

          <div className={cn(
            'mt-2.5 grid gap-2',
            metadata.docHubUrl || canEmbed ? 'grid-cols-2' : 'grid-cols-1',
          )}>
            <a
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors duration-100 hover:text-[var(--text-primary)]"
            >
              <ExternalLink size={11} />
              {metadata.previewLabel || 'Open Doc'}
            </a>
            {metadata.docHubUrl ? (
              <a
                href={metadata.docHubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-xs font-medium text-blue-400 transition-colors duration-100 hover:bg-blue-500/20"
              >
                <ExternalLink size={11} />
                Open in OWL
              </a>
            ) : canEmbed ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-xs font-medium text-blue-400 transition-colors duration-100 hover:bg-blue-500/20"
              >
                <Maximize2 size={11} />
                Review document
              </button>
            ) : null}
          </div>

          {canEmbed && typeof document !== 'undefined' && createPortal(
            <Modal
              isOpen={expanded}
              onClose={() => setExpanded(false)}
              title={title}
              size="2xl"
              className="h-[calc(100vh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none"
              overlayClassName="items-center pt-0"
              contentTestId="expanded-document-preview"
            >
              <div className="min-h-0 flex-1 overflow-hidden border-t border-[var(--border)]">
                <DocumentPreview
                  url={previewUrl}
                  title={title}
                  type={previewType}
                  expanded
                />
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3">
                <p className="truncate text-xs text-[var(--text-muted)]">
                  {metadata.correspondent || 'Paperless-ngx'}
                  {typeof metadata.amount === 'number' ? ` · $${metadata.amount.toFixed(2)}` : ''}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {metadata.docHubUrl && (
                    <a
                      href={metadata.docHubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      Open in OWL
                    </a>
                  )}
                  <a
                    href={originalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]"
                  >
                    <ExternalLink size={11} />
                    Open original
                  </a>
                </div>
              </div>
            </Modal>,
            document.body,
          )}
        </>
      ) : (
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={metadata.previewLabel || 'Open Document'}
          className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--accent)] transition-colors duration-150 hover:border-[var(--accent)]/50"
        >
          <ExternalLink size={14} className="shrink-0" />
          <span className="truncate">{metadata.previewLabel || 'Open Document'}</span>
          {metadata.correspondent && (
            <span className="ml-auto text-[var(--text-muted)]">
              {metadata.correspondent}
              {typeof metadata.amount === 'number' ? ` · $${metadata.amount.toFixed(2)}` : ''}
            </span>
          )}
        </a>
      )}
    </div>
  );
}

function MetadataItem({
  label,
  value,
  accent,
  capitalize,
}: {
  label: string;
  value: string;
  accent?: boolean;
  capitalize?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
      <dd className={cn(
        'mt-0.5 truncate text-xs font-medium text-[var(--text-secondary)]',
        accent && 'font-semibold tabular-nums text-emerald-400',
        capitalize && 'capitalize',
      )}>
        {value}
      </dd>
    </div>
  );
}
