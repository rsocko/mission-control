import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentContentUrl,
  getAttachmentPreviewKind,
  TaskAttachmentPreview,
} from '@/components/task-detail/TaskAttachmentPreview';

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div role="dialog" aria-label={title}>{children}</div>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('task attachment previews', () => {
  it.each([
    ['photo.png', 'image/png', 'image'],
    ['notes.md', 'application/octet-stream', 'markdown'],
    ['data.json', 'application/json', 'text'],
    ['report.pdf', 'application/pdf', 'pdf'],
    ['recording.mp3', 'audio/mpeg', 'audio'],
    ['demo.mp4', 'video/mp4', 'video'],
  ] as const)('recognizes %s as an in-app %s preview', (name, contentType, expected) => {
    expect(getAttachmentPreviewKind({ id: '1', name, contentType })).toBe(expected);
  });

  it('uses download fallback for unknown binary files', () => {
    expect(getAttachmentPreviewKind({
      id: '1',
      name: 'archive.zip',
      contentType: 'application/zip',
    })).toBeNull();
  });

  it('does not iframe active content with a misleading PDF extension', () => {
    expect(getAttachmentPreviewKind({
      id: '1',
      name: 'not-a-report.pdf',
      contentType: 'text/html',
    })).toBe('text');
  });

  it('encodes task and attachment IDs in content URLs', () => {
    expect(attachmentContentUrl('task/1', 'attachment #1', true))
      .toBe('/api/tasks/task%2F1/attachments/attachment%20%231?inline=1');
  });

  it('loads and renders Markdown with a download fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['# Preview heading'], { type: 'text/markdown' }),
    }));

    render(
      <TaskAttachmentPreview
        taskId="task-1"
        attachment={{ id: 'attachment-1', name: 'notes.md', contentType: 'text/markdown' }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Loading preview...')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Preview heading' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' }))
      .toHaveAttribute('href', '/api/tasks/task-1/attachments/attachment-1');
  });

  it('revokes binary preview URLs when the preview closes', async () => {
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['image'], { type: 'image/png' }),
    }));
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    const { unmount } = render(
      <TaskAttachmentPreview
        taskId="task-1"
        attachment={{ id: 'attachment-1', name: 'image.png', contentType: 'image/png' }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('shows a download fallback when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      blob: async () => new Blob(),
    }));

    render(
      <TaskAttachmentPreview
        taskId="task-1"
        attachment={{ id: 'attachment-1', name: 'notes.txt', contentType: 'text/plain' }}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('Attachment could not be loaded')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download the file instead' })).toBeInTheDocument();
  });
});
