'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { findAllNLPDates } from '@/lib/date-parser';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  EditorConfig,
  EditorState,
  KEY_DOWN_COMMAND,
  LexicalEditor,
  SerializedTextNode,
  TextNode,
} from 'lexical';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { taskLogger } from '@/lib/client-logger';

// ─── Token Node ─────────────────────────────────────────────────────────────
// A custom TextNode subclass that renders with colored styles based on token type.

type TokenType = 'slash' | 'destination' | 'priority-critical' | 'priority-high' | 'priority-medium' | 'priority-low' | 'tag' | 'project' | 'duration' | 'horizon' | 'date' | 'effort';

const TOKEN_STYLES: Record<TokenType, { color: string; fontWeight: string }> = {
  slash: { color: 'var(--accent)', fontWeight: '500' },
  destination: { color: '#60a5fa', fontWeight: '500' },
  'priority-critical': { color: '#fb7185', fontWeight: '600' },
  'priority-high': { color: '#fb923c', fontWeight: '500' },
  'priority-medium': { color: '#fcd34d', fontWeight: '500' },
  'priority-low': { color: '#38bdf8', fontWeight: '500' },
  tag: { color: '#c084fc', fontWeight: '500' },
  project: { color: '#f472b6', fontWeight: '500' },
  duration: { color: '#22d3ee', fontWeight: '500' },
  horizon: { color: 'var(--success)', fontWeight: '600' },
  date: { color: '#4ade80', fontWeight: '500' },
  effort: { color: '#a78bfa', fontWeight: '500' },
};

class TokenNode extends TextNode {
  __tokenType: TokenType;

  static getType(): string {
    return 'token';
  }

  static clone(node: TokenNode): TokenNode {
    return new TokenNode(node.__text, node.__tokenType, node.__key);
  }

  constructor(text: string, tokenType: TokenType, key?: string) {
    super(text, key);
    this.__tokenType = tokenType;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    const style = TOKEN_STYLES[this.__tokenType];
    dom.style.color = style.color;
    dom.style.fontWeight = style.fontWeight;
    dom.classList.add('token-node');
    dom.setAttribute('data-lexical-token', 'true');
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const updated = super.updateDOM(prevNode, dom, config);
    if (prevNode.__tokenType !== this.__tokenType) {
      const style = TOKEN_STYLES[this.__tokenType];
      dom.style.color = style.color;
      dom.style.fontWeight = style.fontWeight;
      return true;
    }
    return updated;
  }

  static importJSON(serializedNode: SerializedTextNode & { tokenType: TokenType }): TokenNode {
    return new TokenNode(serializedNode.text, serializedNode.tokenType);
  }

  exportJSON(): SerializedTextNode & { tokenType: TokenType } {
    return {
      ...super.exportJSON(),
      type: 'token',
      tokenType: this.__tokenType,
    };
  }
}

// ─── Token Detection Rules ──────────────────────────────────────────────────

interface TokenMatch {
  start: number;
  end: number;
  type: TokenType;
}

// (Date detection is now handled by chrono-node via findAllNLPDates)

function findTokens(text: string, naturalLanguageDates: boolean): TokenMatch[] {
  const tokens: TokenMatch[] = [];

  // /listname at start
  const slashMatch = text.match(/^\/\S+/);
  if (slashMatch) {
    tokens.push({ start: 0, end: slashMatch[0].length, type: 'slash' });
  }

  // @destination (not escaped with \)
  const destRegex = /(?<!\\)@(work|personal|github|todo)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = destRegex.exec(text)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, type: 'destination' });
  }

  // !priority (not escaped with \)
  const priRegex = /(?<!\\)!(critical|high|medium|low)\b/gi;
  while ((m = priRegex.exec(text)) !== null) {
    const pri = m[1].toLowerCase();
    const type: TokenType = pri === 'critical' ? 'priority-critical' : pri === 'high' ? 'priority-high' : pri === 'low' ? 'priority-low' : 'priority-medium';
    tokens.push({ start: m.index, end: m.index + m[0].length, type });
  }

  // #tags (not escaped with \)
  const tagRegex = /(?<!\\)#[a-zA-Z0-9_:./-]+/g;
  while ((m = tagRegex.exec(text)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, type: 'tag' });
  }

  const projectRegex = /(?<!\\)\+(?:"[^"]+"|[a-zA-Z][a-zA-Z0-9_-]*)/g;
  while ((m = projectRegex.exec(text)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, type: 'project' });
  }

  // ~duration (not escaped with \)
  const durRegex = /(?<!\\)~\d+(?:\.\d+)?\s*(?:m|min|mins|h|hr|hrs|hour|hours)\b/gi;
  while ((m = durRegex.exec(text)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, type: 'duration' });
  }

  const horizonRegex = /(?<!\\)~(?:next|soon|later|someday)\b/gi;
  while ((m = horizonRegex.exec(text)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, type: 'horizon' });
  }

  // ^effort (^1 through ^5, not escaped with \)
  const effortRegex = /(?<!\\)\^[1-5]\b/g;
  while ((m = effortRegex.exec(text)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, type: 'effort' });
  }

  // NLP date detection via chrono-node
  const nlpDates = naturalLanguageDates ? findAllNLPDates(text) : [];
  for (const nlpDate of nlpDates) {
    const start = nlpDate.index;
    const end = start + nlpDate.matchedText.length;
    // Check for backslash escape just before the match
    if (start > 0 && text[start - 1] === '\\') continue;
    // Don't overlap with already-detected tokens
    const overlaps = tokens.some(t => start < t.end && end > t.start);
    if (!overlaps) {
      tokens.push({ start, end, type: 'date' });
    }
  }

  // Sort by start position
  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

// ─── Transform Plugin ───────────────────────────────────────────────────────
// Transforms plain TextNodes into TokenNodes when they match patterns.
// Preserves cursor position across splits to avoid caret jumps.

function TokenTransformPlugin({ naturalLanguageDates }: { naturalLanguageDates: boolean }): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const removeTransform = editor.registerNodeTransform(TextNode, (node) => {
      // Don't transform TokenNodes (they extend TextNode)
      if (node instanceof TokenNode) return;

      const text = node.getTextContent();
      const tokens = findTokens(text, naturalLanguageDates);
      if (tokens.length === 0) return;

      // Capture selection offset within this node before splitting
      const selection = $getSelection();
      let selectionOffset: number | null = null;
      if ($isRangeSelection(selection)) {
        const anchor = selection.anchor;
        if (anchor.key === node.getKey() && anchor.type === 'text') {
          selectionOffset = anchor.offset;
        }
      }

      // Build replacement nodes
      const nodes: (TextNode | TokenNode)[] = [];
      let lastEnd = 0;

      for (const token of tokens) {
        // Ensure no overlaps
        if (token.start < lastEnd) continue;

        if (token.start > lastEnd) {
          nodes.push($createTextNode(text.slice(lastEnd, token.start)));
        }
        nodes.push(new TokenNode(text.slice(token.start, token.end), token.type));
        lastEnd = token.end;
      }

      if (lastEnd < text.length) {
        nodes.push($createTextNode(text.slice(lastEnd)));
      }

      // Replace the original node with our split nodes
      if (nodes.length > 0) {
        const first = nodes[0];
        node.replace(first);
        let prev = first;
        for (let i = 1; i < nodes.length; i++) {
          prev.insertAfter(nodes[i]);
          prev = nodes[i];
        }

        // Restore cursor position
        if (selectionOffset !== null) {
          let remaining = selectionOffset;
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const len = n.getTextContentSize();
            if (remaining <= len || i === nodes.length - 1) {
              // Clamp to node length for the last node
              n.select(Math.min(remaining, len), Math.min(remaining, len));
              break;
            }
            remaining -= len;
          }
        }
      }
    });

    // Also handle TokenNodes — un-tokenize them when they no longer match
    const removeTokenTransform = editor.registerNodeTransform(TokenNode, (node) => {
      const text = node.getTextContent();
      const tokens = findTokens(text, naturalLanguageDates);
      // If this node's text no longer fully matches a single token, convert back to plain text
      const fullMatch = tokens.length === 1 && tokens[0].start === 0 && tokens[0].end === text.length;
      if (!fullMatch) {
        // Preserve cursor
        const selection = $getSelection();
        let selectionOffset: number | null = null;
        if ($isRangeSelection(selection)) {
          const anchor = selection.anchor;
          if (anchor.key === node.getKey() && anchor.type === 'text') {
            selectionOffset = anchor.offset;
          }
        }

        const plain = $createTextNode(text);
        node.replace(plain);
        if (selectionOffset !== null) {
          plain.select(selectionOffset, selectionOffset);
        }
      }
    });

    return () => {
      removeTransform();
      removeTokenTransform();
    };
  }, [editor, naturalLanguageDates]);

  return null;
}

// ─── Single Line Plugin ─────────────────────────────────────────────────────
// Prevents multi-line input by intercepting Enter.
// Newline stripping from pasted content is handled in TokenTransformPlugin.

// ─── Focus/Blur Plugin ──────────────────────────────────────────────────────

function FocusPlugin({ onFocus, onBlur }: { onFocus: () => void; onBlur: () => void }): null {
  const [editor] = useLexicalComposerContext();
  const onFocusRef = useRef(onFocus);
  const onBlurRef = useRef(onBlur);
  onFocusRef.current = onFocus;
  onBlurRef.current = onBlur;

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const handleFocus = () => onFocusRef.current();
    const handleBlur = () => onBlurRef.current();
    root.addEventListener('focus', handleFocus);
    root.addEventListener('blur', handleBlur);
    return () => {
      root.removeEventListener('focus', handleFocus);
      root.removeEventListener('blur', handleBlur);
    };
  }, [editor]);

  return null;
}

// ─── Keyboard Plugin ────────────────────────────────────────────────────────
// Forwards key events to the parent for typeahead & submit handling.
// Uses a ref to avoid re-registering the command listener on every render.

function KeyboardPlugin({ onKeyDown }: { onKeyDown: (e: KeyboardEvent) => boolean }): null {
  const [editor] = useLexicalComposerContext();
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        return onKeyDownRef.current(event);
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

// ─── Escape Token Plugin ────────────────────────────────────────────────────
// Pressing Escape escapes the nearest detected token to the cursor by prepending \.

function escapeTokenNode(editor: LexicalEditor, node: TokenNode): void {
  const text = node.getTextContent();
  const escaped = '\\' + text;
  const plain = $createTextNode(escaped);
  node.replace(plain);
  plain.select(escaped.length, escaped.length);

  // Flash animation after DOM reconciliation
  const key = plain.getKey();
  setTimeout(() => {
    const dom = editor.getElementByKey(key);
    if (dom) {
      dom.classList.add('token-escaped-flash');
      dom.addEventListener('animationend', () => {
        dom.classList.remove('token-escaped-flash');
      }, { once: true });
    }
  }, 0);
}

function EscapeTokenPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return false;

        // Find the nearest TokenNode to the cursor
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();

        // Case 1: Cursor is inside a TokenNode
        if (anchorNode instanceof TokenNode) {
          event.preventDefault();
          escapeTokenNode(editor, anchorNode);
          return true;
        }

        // Case 2: Cursor is in a TextNode — find adjacent TokenNode
        const prevSibling = anchorNode.getPreviousSibling();
        const nextSibling = anchorNode.getNextSibling();

        // Cursor at start of node, token immediately before
        if (anchor.offset === 0 && prevSibling instanceof TokenNode) {
          event.preventDefault();
          escapeTokenNode(editor, prevSibling);
          return true;
        }

        // Cursor at end of node, token immediately after
        if (anchor.type === 'text' && anchor.offset === anchorNode.getTextContentSize() && nextSibling instanceof TokenNode) {
          event.preventDefault();
          escapeTokenNode(editor, nextSibling);
          return true;
        }

        // Case 3: Find the closest TokenNode, but only within a proximity threshold
        const MAX_ESCAPE_DISTANCE = 12; // chars — don't escape tokens far from cursor
        const parent = anchorNode.getParent();
        if (parent) {
          const children = parent.getChildren();
          let closestToken: TokenNode | null = null;
          let closestDistance = Infinity;

          // Calculate cursor's absolute offset in the paragraph
          let cursorAbsOffset = 0;
          for (const child of children) {
            if (child.getKey() === anchorNode.getKey()) {
              cursorAbsOffset += anchor.type === 'text' ? anchor.offset : 0;
              break;
            }
            cursorAbsOffset += child.getTextContentSize();
          }

          // Find closest token by distance to token edge (not midpoint)
          let offset = 0;
          for (const child of children) {
            if (child instanceof TokenNode) {
              const tokenStart = offset;
              const tokenEnd = offset + child.getTextContentSize();
              // Distance = chars between cursor and nearest edge of token
              const dist = cursorAbsOffset < tokenStart
                ? tokenStart - cursorAbsOffset
                : cursorAbsOffset > tokenEnd
                  ? cursorAbsOffset - tokenEnd
                  : 0; // cursor overlaps token range
              if (dist < closestDistance) {
                closestDistance = dist;
                closestToken = child;
              }
            }
            offset += child.getTextContentSize();
          }

          if (closestToken && closestDistance <= MAX_ESCAPE_DISTANCE) {
            event.preventDefault();
            escapeTokenNode(editor, closestToken);
            return true;
          }
        }

        // No nearby tokens — don't handle, let parent clear/blur as normal
        return false;
      },
      COMMAND_PRIORITY_CRITICAL, // Higher than KeyboardPlugin so we intercept Escape first when tokens exist
    );
  }, [editor]);

  return null;
}

// ─── Token Dismiss Plugin ───────────────────────────────────────────────────
// Shows a ✕ dismiss button on hover over detected tokens. Clicking it escapes the token.

function TokenDismissPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.hasAttribute('data-lexical-token')) return;

      // Check if click is in the dismiss region (the ✕ area right of the token)
      const rect = target.getBoundingClientRect();
      const clickX = event.clientX;
      // ✕ is positioned at right: -14px, so it's outside the span to the right
      if (clickX < rect.right - 2) return; // Click is inside the token text, not the dismiss zone

      event.preventDefault();
      event.stopPropagation();

      // Find the Lexical node key from the DOM before entering update
      editor.update(() => {
        const root = $getRoot();
        const paragraph = root.getFirstChild();
        if (!paragraph || !$isElementNode(paragraph)) return;
        const children = paragraph.getChildren();

        for (const child of children) {
          if (child instanceof TokenNode) {
            const dom = editor.getElementByKey(child.getKey());
            if (dom === target) {
              escapeTokenNode(editor, child);
              break;
            }
          }
        }
      });
    };

    root.addEventListener('click', handleClick);
    return () => root.removeEventListener('click', handleClick);
  }, [editor]);

  return null;
}

// ─── Imperative handle ──────────────────────────────────────────────────────
// Exposes focus/blur/getText/setText to the parent component.

export interface TokenInputHandle {
  focus: () => void;
  blur: () => void;
  getText: () => string;
  setText: (text: string) => void;
  getEditor: () => LexicalEditor | null;
}

function ImperativePlugin({ handleRef, editorTextRef }: { handleRef: React.MutableRefObject<TokenInputHandle | null>; editorTextRef: React.MutableRefObject<string> }): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    handleRef.current = {
      focus: () => editor.focus(),
      blur: () => editor.getRootElement()?.blur(),
      getText: () => {
        let text = '';
        editor.getEditorState().read(() => {
          text = $getRoot().getTextContent();
        });
        return text;
      },
      setText: (newText: string) => {
        editorTextRef.current = newText;
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          const paragraph = $createParagraphNode();
          if (newText) {
            const textNode = $createTextNode(newText);
            paragraph.append(textNode);
            root.append(paragraph);
            textNode.select(newText.length, newText.length);
          } else {
            root.append(paragraph);
            paragraph.selectEnd();
          }
        });
      },
      getEditor: () => editor,
    };
  }, [editor, handleRef, editorTextRef]);

  return null;
}

// ─── External Sync Plugin ───────────────────────────────────────────────────
// Syncs editor content with parent text state (one-way: parent → editor only when value differs).
// Only fires for truly external changes (clear, prefill) — not for the editor's own typing.

function ExternalSyncPlugin({ value, editorTextRef }: { value: string; editorTextRef: React.MutableRefObject<string> }): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Only push external changes in (e.g. when parent clears input or prefills)
    if (value !== editorTextRef.current) {
      editorTextRef.current = value;
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        if (value) {
          const textNode = $createTextNode(value);
          paragraph.append(textNode);
          root.append(paragraph);
          textNode.select(value.length, value.length);
        } else {
          root.append(paragraph);
          paragraph.selectEnd();
        }
      });
    }
  }, [value, editor, editorTextRef]);

  return null;
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface TokenInputProps {
  value: string;
  onChange: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent) => boolean;
  placeholder?: string;
  handleRef?: React.MutableRefObject<TokenInputHandle | null>;
  className?: string;
  naturalLanguageDates?: boolean;
}

function ErrorBoundaryFallback(): React.ReactElement {
  return <div className="text-red-400 text-xs">Editor error</div>;
}

export function TokenInput({
  value,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
  placeholder = 'Add a task...',
  handleRef,
  className,
  naturalLanguageDates = true,
}: TokenInputProps) {
  const editorTextRef = useRef(''); // Start empty so ExternalSyncPlugin applies initial value
  const handleRefFallback = useRef<TokenInputHandle | null>(null);
  const actualHandleRef = handleRef || handleRefFallback;

  const initialConfig = useMemo(
    () => ({
      namespace: 'QuickAddTokenInput',
      onError: (error: Error) => taskLogger.error('TokenInput error', { error: error.message }),
      nodes: [TokenNode],
      theme: {
        root: 'token-input-root',
        paragraph: 'token-input-paragraph',
      },
    }),
    [],
  );

  const handleChange = useCallback(
    (editorState: EditorState) => {
      editorState.read(() => {
        const text = $getRoot().getTextContent();
        // Only notify parent if text actually changed (avoids redundant renders from transform-only updates)
        if (text !== editorTextRef.current) {
          editorTextRef.current = text;
          onChange(text);
        }
      });
    },
    [onChange],
  );

  const handleFocus = useCallback(() => onFocus?.(), [onFocus]);
  const handleBlur = useCallback(() => onBlur?.(), [onBlur]);
  const handleKeyDownCb = useCallback(
    (e: KeyboardEvent) => onKeyDown?.(e) ?? false,
    [onKeyDown],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className={`relative flex-1 ${className || ''}`}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="min-h-[1.5em] w-full whitespace-pre-wrap break-words border-none bg-transparent py-2 text-sm text-[var(--text-primary)] ring-0 outline-none"
              aria-label="Task title"
            />
          }
          placeholder={
            <div className="absolute top-0 left-0 py-2 text-sm text-[var(--text-muted)] pointer-events-none select-none">
              {placeholder}
            </div>
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ErrorBoundary={ErrorBoundaryFallback as any}
        />
        <OnChangePlugin onChange={handleChange} />
        <HistoryPlugin />
        <TokenTransformPlugin naturalLanguageDates={naturalLanguageDates} />
        <FocusPlugin onFocus={handleFocus} onBlur={handleBlur} />
        <KeyboardPlugin onKeyDown={handleKeyDownCb} />
        <EscapeTokenPlugin />
        <TokenDismissPlugin />
        <ImperativePlugin handleRef={actualHandleRef} editorTextRef={editorTextRef} />
        <ExternalSyncPlugin value={value} editorTextRef={editorTextRef} />
      </div>
    </LexicalComposer>
  );
}
