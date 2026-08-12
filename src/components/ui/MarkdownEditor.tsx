'use client';

import {
  useCallback,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type TextareaHTMLAttributes,
} from 'react';
import { Bold, Code, Italic, Link2, List } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from './Tooltip';

type MarkdownAction = 'bold' | 'italic' | 'link' | 'code' | 'list';

const MARKDOWN_ACTIONS: Array<{
  action: MarkdownAction;
  label: string;
  shortcut?: string;
  icon: typeof Bold;
}> = [
  { action: 'bold', label: 'Bold', shortcut: 'Ctrl+B', icon: Bold },
  { action: 'italic', label: 'Italic', shortcut: 'Ctrl+I', icon: Italic },
  { action: 'link', label: 'Insert link', shortcut: 'Ctrl+K', icon: Link2 },
  { action: 'code', label: 'Inline code', icon: Code },
  { action: 'list', label: 'Bulleted list', icon: List },
];

interface MarkdownEditorProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'onBlur' | 'onChange' | 'value'
> {
  value: string;
  onValueChange: (value: string) => void;
  onEditorBlur?: () => unknown;
  onEscape?: () => void;
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
  containerClassName?: string;
  toolbarClassName?: string;
}

export function MarkdownEditor({
  value,
  onValueChange,
  onEditorBlur,
  onEscape,
  textareaRef,
  containerClassName,
  toolbarClassName,
  className,
  onKeyDown,
  ...textareaProps
}: MarkdownEditorProps) {
  const internalRef = useRef<HTMLTextAreaElement | null>(null);

  const formatSelection = useCallback((action: MarkdownAction) => {
    const textarea = internalRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    let nextValue: string;
    let nextSelectionStart: number;
    let nextSelectionEnd: number;

    if (action === 'list') {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const effectiveEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
      const followingNewline = value.indexOf('\n', effectiveEnd);
      const lineEnd = followingNewline === -1 ? value.length : followingNewline;
      const selectedLines = value.slice(lineStart, lineEnd);
      const lines = selectedLines.split('\n');
      const formattedLines = lines.map((line) => `- ${line}`).join('\n');
      nextValue = value.slice(0, lineStart) + formattedLines + value.slice(lineEnd);
      nextSelectionStart = start + 2;
      nextSelectionEnd = end + (2 * lines.length);
    } else {
      const [prefix, suffix] = {
        bold: ['**', '**'],
        italic: ['_', '_'],
        link: ['[', '](url)'],
        code: ['`', '`'],
      }[action];
      const selected = value.slice(start, end);
      nextValue = value.slice(0, start) + prefix + selected + suffix + value.slice(end);
      nextSelectionStart = start + prefix.length;
      nextSelectionEnd = nextSelectionStart + selected.length;
    }

    onValueChange(nextValue);
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    }, 0);
  }, [onValueChange, value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && onEscape) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      const action = {
        b: 'bold',
        i: 'italic',
        k: 'link',
      }[event.key.toLowerCase()] as MarkdownAction | undefined;
      if (action) {
        event.preventDefault();
        formatSelection(action);
        return;
      }
    }

    onKeyDown?.(event);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    onEditorBlur?.();
  };

  return (
    <div className={containerClassName} onBlur={handleBlur} data-markdown-editor>
      <div
        role="toolbar"
        aria-label="Markdown formatting"
        className={cn(
          'flex items-center gap-0.5 border-b border-[var(--border-subtle)]',
          toolbarClassName,
        )}
      >
        {MARKDOWN_ACTIONS.map(({ action, label, shortcut, icon: Icon }) => (
          <Tooltip key={action} content={label} shortcut={shortcut}>
            <button
              type="button"
              aria-label={label}
              aria-keyshortcuts={shortcut
                ? `${shortcut.replace('Ctrl', 'Control')} ${shortcut.replace('Ctrl', 'Meta')}`
                : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => formatSelection(action)}
              className="flex min-h-8 min-w-8 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <Icon size={12} aria-hidden="true" />
            </button>
          </Tooltip>
        ))}
      </div>
      <textarea
        {...textareaProps}
        ref={(node) => {
          internalRef.current = node;
          if (textareaRef) textareaRef.current = node;
        }}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className={className}
      />
    </div>
  );
}
