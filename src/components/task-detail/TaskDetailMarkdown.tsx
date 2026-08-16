'use client';

import { createContext, useContext, useState, type ImgHTMLAttributes } from 'react';
import dynamic from 'next/dynamic';
import { ExternalLink, ImageOff } from 'lucide-react';

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const RAW_IMAGE_TAG_PATTERN = /^\s*<img\b(?:(?:"[^"]*"|'[^']*'|[^'">])*)\/?>\s*$/i;

/**
 * Downgrade every raw HTML node except standalone `<img>` tags to plain text so
 * task notes can embed images without becoming an HTML injection surface.
 */
export function remarkOnlyEmbeddedImages() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      node.children?.forEach((child) => {
        if (child.type === 'html' && !RAW_IMAGE_TAG_PATTERN.test(child.value ?? '')) {
          child.type = 'text';
        } else {
          visit(child);
        }
      });
    };

    visit(tree);
  };
}

/** Source URL used by the fallback shown when an embedded image fails to load. */
export const MarkdownSourceUrlContext = createContext<string | null>(null);

/** Renders a markdown image and degrades to an explanatory card when it fails. */
export function EmbeddedMarkdownImage({
  src,
  alt,
  onError,
  ...imageProps
}: ImgHTMLAttributes<HTMLImageElement>) {
  const sourceUrl = useContext(MarkdownSourceUrlContext);
  const [failedSrc, setFailedSrc] = useState<ImgHTMLAttributes<HTMLImageElement>['src'] | null>(null);
  const failed = src != null && failedSrc === src;
  const isPrivateGitHubAttachment = typeof src === 'string'
    && src.startsWith('https://github.com/user-attachments/assets/');

  if (failed) {
    return (
      <span className="not-prose my-2 flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4 text-[var(--text-secondary)]">
        <span className="flex items-start gap-3">
          <ImageOff className="mt-0.5 shrink-0 text-[var(--text-muted)]" size={18} aria-hidden="true" />
          <span>
            <span className="block text-sm font-medium text-[var(--text-primary)]">Image unavailable</span>
            <span className="mt-1 block text-xs text-[var(--text-muted)]">
              {isPrivateGitHubAttachment
                ? 'Private GitHub attachment could not be loaded.'
                : `${alt || 'The embedded image'} could not be loaded.`}
            </span>
          </span>
        </span>
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-blue-400 hover:underline"
          >
            {isPrivateGitHubAttachment ? 'Open task in GitHub' : 'Open source task'}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </span>
    );
  }

  return (
    // Markdown images can point to arbitrary remote hosts, so Next Image cannot safely optimize them.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...imageProps}
      src={src}
      alt={alt ?? ''}
      onError={(event) => {
        onError?.(event);
        setFailedSrc(src ?? null);
      }}
    />
  );
}

export interface TaskDetailMarkdownProps {
  children: string;
  /** Called when a rendered task-list checkbox is toggled. Omit to render read-only. */
  onCheckboxToggle?: (index: number, checked: boolean) => void;
  /** Task source URL offered when an embedded image cannot be loaded. */
  sourceUrl?: string | null;
}

/**
 * Sanitized markdown renderer for task notes. The heavy markdown pipeline is
 * loaded lazily on the client only.
 */
export const TaskDetailMarkdown = dynamic(
  async () => {
    const [
      { default: ReactMarkdown },
      { default: rehypeHighlight },
      { default: rehypeRaw },
      { default: rehypeSanitize },
      { default: remarkBreaks },
      { default: remarkGfm },
    ] = await Promise.all([
      import('react-markdown'),
      import('rehype-highlight'),
      import('rehype-raw'),
      import('rehype-sanitize'),
      import('remark-breaks'),
      import('remark-gfm'),
    ]);
    return function InteractiveMarkdown(props: TaskDetailMarkdownProps) {
      let checkboxIndex = -1;
      return (
        <MarkdownSourceUrlContext.Provider value={props.sourceUrl ?? null}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks, remarkOnlyEmbeddedImages]}
            rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeHighlight]}
            components={{
              a: ({ node, href, ...anchorProps }) => {
                void node;
                const isExternal = /^https?:\/\//i.test(href ?? '');
                return (
                  <a
                    {...anchorProps}
                    href={href}
                    rel={isExternal ? 'noopener noreferrer' : undefined}
                    target={isExternal ? '_blank' : undefined}
                  />
                );
              },
              img: EmbeddedMarkdownImage,
              input: (inputProps) => {
                if (inputProps.type === 'checkbox') {
                  checkboxIndex++;
                  const idx = checkboxIndex;
                  return (
                    <input
                      type="checkbox"
                      checked={!!inputProps.checked}
                      onChange={(e) => {
                        e.stopPropagation();
                        props.onCheckboxToggle?.(idx, e.target.checked);
                      }}
                      className="cursor-pointer mr-1"
                    />
                  );
                }
                return <input {...inputProps} />;
              },
            }}
          >
            {props.children}
          </ReactMarkdown>
        </MarkdownSourceUrlContext.Provider>
      );
    };
  },
  { ssr: false, loading: () => <div className="animate-pulse h-4 bg-[var(--surface-1)] rounded w-3/4" /> },
);

const TASK_LIST_ITEM_PATTERN = /^([\s]*-\s+\[)([ xX])(\]\s+.+)$/gm;

/**
 * Flip the nth markdown task-list checkbox, preserving every other line.
 * Indexes match the order checkboxes are rendered in.
 */
export function toggleMarkdownCheckbox(
  markdown: string,
  index: number,
  checked: boolean,
): string {
  let checkboxIndex = -1;
  return markdown.replace(TASK_LIST_ITEM_PATTERN, (match, prefix, state, suffix) => {
    void state;
    checkboxIndex++;
    if (checkboxIndex === index) {
      return `${prefix}${checked ? 'x' : ' '}${suffix}`;
    }
    return match;
  });
}
