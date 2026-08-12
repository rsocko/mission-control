'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { Download, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Modal } from '@/components/ui/Modal';

export interface PreviewAttachment {
  id: string;
  name: string;
  contentType: string;
}

export type AttachmentPreviewKind = 'image' | 'markdown' | 'text' | 'pdf' | 'audio' | 'video';

const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function getAttachmentPreviewKind(attachment: PreviewAttachment): AttachmentPreviewKind | null {
  const contentType = attachment.contentType.split(';', 1)[0].trim().toLowerCase();
  const extension = extensionOf(attachment.name);
  const genericContentType = !contentType || contentType === 'application/octet-stream';

  if (contentType === 'text/markdown' || contentType === 'text/x-markdown' || ['.md', '.markdown'].includes(extension)) {
    return 'markdown';
  }
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'application/pdf' || (genericContentType && extension === '.pdf')) return 'pdf';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('text/') || TEXT_CONTENT_TYPES.has(contentType)
    || ['.txt', '.log', '.json', '.xml', '.yaml', '.yml', '.csv'].includes(extension)) {
    return 'text';
  }
  return null;
}

export function attachmentContentUrl(taskId: string, attachmentId: string, inline = false): string {
  const base = `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`;
  return inline ? `${base}?inline=1` : base;
}

interface TaskAttachmentPreviewProps {
  taskId: string;
  attachment: PreviewAttachment | null;
  onClose: () => void;
}

export function TaskAttachmentPreview({ taskId, attachment, onClose }: TaskAttachmentPreviewProps) {
  const kind = attachment ? getAttachmentPreviewKind(attachment) : null;
  const [content, setContent] = useState<{
    attachmentId: string;
    objectUrl: string | null;
    text: string | null;
    error: string | null;
  } | null>(null);
  const inlineUrl = useMemo(
    () => attachment ? attachmentContentUrl(taskId, attachment.id, true) : null,
    [attachment, taskId],
  );

  useEffect(() => {
    if (!attachment || !kind || !inlineUrl) return;

    const controller = new AbortController();
    let createdObjectUrl: string | null = null;
    let disposed = false;
    const attachmentId = attachment.id;

    void fetch(inlineUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Attachment could not be loaded');
        const blob = await response.blob();
        if (disposed) return;
        if (kind === 'markdown' || kind === 'text') {
          const nextText = await blob.text();
          if (!disposed) {
            setContent({ attachmentId, objectUrl: null, text: nextText, error: null });
          }
        } else {
          createdObjectUrl = URL.createObjectURL(blob);
          if (disposed) {
            URL.revokeObjectURL(createdObjectUrl);
            createdObjectUrl = null;
          } else {
            setContent({ attachmentId, objectUrl: createdObjectUrl, text: null, error: null });
          }
        }
      })
      .catch((fetchError: unknown) => {
        if (disposed || (fetchError instanceof DOMException && fetchError.name === 'AbortError')) return;
        setContent({
          attachmentId,
          objectUrl: null,
          text: null,
          error: fetchError instanceof Error ? fetchError.message : 'Attachment could not be loaded',
        });
      });

    return () => {
      disposed = true;
      controller.abort();
      if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
    };
  }, [attachment, inlineUrl, kind]);

  if (!attachment || !kind) return null;

  const currentContent = content?.attachmentId === attachment.id ? content : null;
  const loading = currentContent === null;
  const { error, objectUrl, text } = currentContent ?? { error: null, objectUrl: null, text: null };
  const downloadUrl = attachmentContentUrl(taskId, attachment.id);

  return (
    <Modal isOpen onClose={onClose} title={attachment.name} size="xl" className="h-[80vh]">
      <div className="flex items-center justify-end border-b border-[var(--border-subtle)] px-5 pb-3">
        <a
          href={downloadUrl}
          download={attachment.name}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
        >
          <Download size={14} />
          Download
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {loading && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 size={18} className="animate-spin" />
            Loading preview...
          </div>
        )}
        {error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--text-muted)]">
            <p>{error}</p>
            <a href={downloadUrl} download={attachment.name} className="text-blue-400 hover:underline">
              Download the file instead
            </a>
          </div>
        )}
        {!error && kind === 'image' && objectUrl && (
          <div className="relative h-full min-h-[60vh] w-full">
            <Image src={objectUrl} alt={attachment.name} fill unoptimized className="object-contain" />
          </div>
        )}
        {!error && kind === 'markdown' && text !== null && (
          <div className="prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        )}
        {!error && kind === 'text' && text !== null && (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-[var(--text-secondary)]">{text}</pre>
        )}
        {!error && kind === 'pdf' && objectUrl && (
          <iframe src={objectUrl} title={attachment.name} className="h-full min-h-[60vh] w-full rounded-md bg-white" />
        )}
        {!error && kind === 'audio' && objectUrl && (
          <div className="flex h-full items-center justify-center">
            <audio src={objectUrl} controls className="w-full max-w-2xl" />
          </div>
        )}
        {!error && kind === 'video' && objectUrl && (
          <video src={objectUrl} controls className="mx-auto max-h-full max-w-full" />
        )}
      </div>
    </Modal>
  );
}
