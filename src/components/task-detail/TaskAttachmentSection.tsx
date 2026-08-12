'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Trash2, Image, FileText, File, Loader2, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  attachmentContentUrl,
  getAttachmentPreviewKind,
  TaskAttachmentPreview,
} from './TaskAttachmentPreview';

interface Attachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sourceAttachmentId?: string;
}

export interface TaskAttachmentSectionProps {
  taskId: string;
  canEdit: boolean;
  /** Whether the connector supports file attachments (true for local & MS Todo) */
  supportsAttachments: boolean;
  /** The connector type (e.g. 'github-issues', 'microsoft-todo', 'local') */
  connectorType?: string;
  /** URL to the task in its source system (used for "open in web" hint) */
  sourceUrl?: string | null;
  /** Incrementing key to trigger a refresh of the attachment list */
  refreshKey?: number;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getFileIcon(contentType: string) {
  if (contentType.startsWith('image/')) return Image;
  if (contentType.includes('pdf') || contentType.includes('document')) return FileText;
  return File;
}

export function TaskAttachmentSection({ taskId, canEdit, supportsAttachments, connectorType, sourceUrl, refreshKey }: TaskAttachmentSectionProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadCount, setUploadCount] = useState(0);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch attachments on mount and when taskId or refreshKey changes
  useEffect(() => {
    fetch(`/api/tasks/${taskId}/attachments`)
      .then(r => r.json())
      .then(data => setAttachments(data.attachments || []))
      .catch(() => setAttachments([]))
      .finally(() => setLoading(false));
  }, [taskId, supportsAttachments, refreshKey]);

  const uploadFile = useCallback(async (file: globalThis.File) => {
    if (file.size > 25 * 1024 * 1024) {
      toast.error('File too large. Maximum size is 25MB.');
      return null;
    }

    setUploadCount(c => c + 1);
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch(`/api/tasks/${taskId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          contentBase64: base64,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }));
        toast.error(err.error || 'Failed to upload attachment');
        return null;
      }

      const data = await res.json();
      const newAttachment = data.attachment;
      setAttachments(prev => [...prev, newAttachment]);
      toast.success(`Attached "${file.name}"`);
      return newAttachment;
    } catch {
      toast.error('Failed to upload attachment');
      return null;
    } finally {
      setUploadCount(c => c - 1);
    }
  }, [taskId]);

  const deleteAttachment = useCallback(async (attachmentId: string, name: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/attachments?attachmentId=${attachmentId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Delete failed');
      setAttachments(prev => prev.filter(a => a.id !== attachmentId));
      toast.success(`Removed "${name}"`);
    } catch {
      toast.error('Failed to delete attachment');
    }
  }, [taskId]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    for (let i = 0; i < files.length; i++) {
      uploadFile(files[i]);
    }
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [uploadFile]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">
          Attachments
          {attachments.length > 0 && (
            <span className="ml-1 text-[var(--text-tertiary)]">({attachments.length})</span>
          )}
        </h3>
        {canEdit && supportsAttachments && (
          <Tooltip content="Attach file">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadCount > 0}
              className="flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-50"
              type="button"
            >
              {uploadCount > 0 ? <Loader2 size={14} className="animate-spin" /> : <><Paperclip size={14} />Add file</>}
            </button>
          </Tooltip>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {!supportsAttachments && (
        <p className="text-[10px] text-[var(--text-muted)] italic mb-2">
          Preserved files remain in Mission Control; new uploads are not supported by this connector.{' '}
          {connectorType === 'github-issues' && sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
              Attach in GitHub
            </a>
          )}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] py-2">
          <Loader2 size={12} className="animate-spin" />
          Loading attachments...
        </div>
      ) : attachments.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)] italic py-1">No attachments</p>
      ) : (
        <div className="space-y-1">
          {attachments.map(att => {
            const Icon = getFileIcon(att.contentType);
            const previewable = getAttachmentPreviewKind(att) !== null;
            const downloadUrl = attachmentContentUrl(taskId, att.id);
            return (
              <div
                key={att.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--surface-0)] border border-[var(--border-subtle)] group hover:border-[var(--border)] transition-colors"
              >
                {previewable ? (
                  <button
                    type="button"
                    onClick={() => setPreviewAttachment(att)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-label={`Preview ${att.name}`}
                  >
                    <Icon size={14} className="text-[var(--text-muted)] shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-[var(--text-secondary)]">{att.name}</span>
                      <span className="block text-[10px] text-[var(--text-muted)]">{formatFileSize(att.size)}</span>
                    </span>
                  </button>
                ) : (
                  <a
                    href={downloadUrl}
                    download={att.name}
                    className="flex min-w-0 flex-1 items-center gap-2"
                    aria-label={`Download ${att.name}`}
                  >
                    <Icon size={14} className="text-[var(--text-muted)] shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-[var(--text-secondary)]">{att.name}</span>
                      <span className="block text-[10px] text-[var(--text-muted)]">{formatFileSize(att.size)}</span>
                    </span>
                  </a>
                )}
                <Tooltip content="Download">
                  <a
                    href={downloadUrl}
                    download={att.name}
                    className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
                    aria-label={`Download ${att.name}`}
                  >
                    <Download size={12} />
                  </a>
                </Tooltip>
                {canEdit && (
                  <Tooltip content="Remove">
                    <button
                      onClick={() => deleteAttachment(att.id, att.name)}
                      className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60 [@media(pointer:coarse)]:opacity-60 p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--surface-2)] transition-all"
                      type="button"
                    >
                      <Trash2 size={12} />
                    </button>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>
      )}
      <TaskAttachmentPreview
        key={previewAttachment?.id ?? 'closed'}
        taskId={taskId}
        attachment={previewAttachment}
        onClose={() => setPreviewAttachment(null)}
      />
    </div>
  );
}

/**
 * Hook for handling paste events in the notes textarea.
 * When an image is pasted, it uploads it as an attachment and inserts a markdown image link.
 */
export function useImagePasteHandler(
  taskId: string,
  supportsAttachments: boolean,
) {
  const [isPasting, setIsPasting] = useState(false);
  const [pasteCount, setPasteCount] = useState(0);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsAttachments) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        // Generate a name for pasted images
        const ext = item.type.split('/')[1] || 'png';
        const name = `pasted-image-${Date.now()}.${ext}`;

        setIsPasting(true);
        try {
          const base64 = await fileToBase64(file);
          const res = await fetch(`/api/tasks/${taskId}/attachments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              contentType: file.type,
              contentBase64: base64,
            }),
          });

          if (res.ok) {
            setPasteCount(c => c + 1);
            toast.success('Image pasted and attached');
          } else {
            toast.error('Failed to upload pasted image');
          }
        } catch {
          toast.error('Failed to upload pasted image');
        } finally {
          setIsPasting(false);
        }
        return; // Handle only the first image
      }
    }
  }, [taskId, supportsAttachments]);

  return { handlePaste, isPasting, pasteCount };
}

/** Convert a File to a base64 string (without the data: prefix) */
function fileToBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data:...;base64, prefix
      const base64 = result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
