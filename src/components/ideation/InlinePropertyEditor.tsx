'use client';

import { useId, useMemo, useState } from 'react';
import { $createParagraphNode, $createTextNode, $getRoot, type EditorState } from 'lexical';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  getIdeationPropertySuggestions,
  parseIdeationProperty,
} from '@/lib/ideation/property-parser';
import type { IdeationProperty } from '@/lib/graph/ideation-types';

interface InlinePropertyEditorProps {
  draft?: string;
  draftKey?: number;
  nodeLabels?: string[];
  autoFocus?: boolean;
  onCancel?: () => void;
  onSubmit: (property: IdeationProperty) => void;
}

export function InlinePropertyEditor({
  draft = '',
  draftKey = 0,
  nodeLabels = [],
  autoFocus = false,
  onCancel,
  onSubmit,
}: InlinePropertyEditorProps) {
  const [value, setValue] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const suggestionsId = useId();
  const suggestions = useMemo(() => {
    const linkMatch = value.match(/^((?:depends-on|related)::\s*)(.*)$/i);
    if (linkMatch) {
      const relationshipValue = linkMatch[2];
      const lastOpen = relationshipValue.lastIndexOf('[[');
      const lastClose = relationshipValue.lastIndexOf(']]');
      const segmentStart = lastOpen > lastClose
        ? lastOpen
        : relationshipValue.lastIndexOf(',') + 1;
      const preservedValue = relationshipValue.slice(0, segmentStart);
      const query = relationshipValue
        .slice(segmentStart)
        .replace(/^\s*\[\[/, '')
        .trim()
        .toLowerCase();
      const separator = preservedValue && !/\s$/.test(preservedValue) ? ' ' : '';
      return nodeLabels
        .filter((label) => label.toLowerCase().includes(query))
        .slice(0, 8)
        .map((label) => ({
          value: `${linkMatch[1]}${preservedValue}${separator}[[${label}]]`,
          label,
          description: 'Link ideation task',
        }));
    }
    return getIdeationPropertySuggestions(value).slice(0, 8);
  }, [nodeLabels, value]);
  const visibleSuggestions = suggestionsOpen ? suggestions : [];

  const replaceValue = (next: string) => {
    setValue(next);
    setError(null);
    setActiveSuggestion(0);
    setSuggestionsOpen(true);
    setEditorKey((key) => key + 1);
  };

  const submit = (input = value) => {
    const parsed = parseIdeationProperty(input);
    if (!parsed.property) {
      setError(parsed.error);
      return;
    }
    onSubmit(parsed.property);
    setValue('');
    setError(null);
    setEditorKey((key) => key + 1);
  };

  return (
    <div className="space-y-1.5">
      <LexicalComposer
        key={`${draftKey}:${draft}:${editorKey}`}
        initialConfig={{
          namespace: 'IdeationPropertyEditor',
          onError: (lexicalError) => {
            throw lexicalError;
          },
          editorState: () => {
            const root = $getRoot();
            root.clear();
            const paragraph = $createParagraphNode();
            if (value) paragraph.append($createTextNode(value));
            root.append(paragraph);
          },
        }}
      >
        <div className="relative">
          <PlainTextPlugin
            contentEditable={(
              <ContentEditable
                aria-label="Inline property"
                aria-autocomplete="list"
                aria-controls={visibleSuggestions.length ? suggestionsId : undefined}
                aria-activedescendant={visibleSuggestions.length
                  ? `${suggestionsId}-option-${activeSuggestion}`
                  : undefined}
                className="min-h-9 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-500)]"
                onKeyDown={(event) => {
                  const currentInput = event.currentTarget.textContent ?? value;
                  const hasValidProperty = Boolean(parseIdeationProperty(currentInput).property);
                  if (event.key === 'Escape') {
                    if (visibleSuggestions.length) {
                      event.preventDefault();
                      setSuggestionsOpen(false);
                      return;
                    }
                    if (onCancel) {
                      event.preventDefault();
                      onCancel();
                    }
                    return;
                  }
                  if (visibleSuggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                    event.preventDefault();
                    const direction = event.key === 'ArrowDown' ? 1 : -1;
                    setActiveSuggestion((index) => (
                      (index + direction + visibleSuggestions.length) % visibleSuggestions.length
                    ));
                    return;
                  }
                  if (
                    visibleSuggestions.length
                    && (event.key === 'Tab' || event.key === 'Enter')
                    && !(event.key === 'Enter' && hasValidProperty)
                    && visibleSuggestions[activeSuggestion]?.value.trim() !== (event.currentTarget.textContent ?? value).trim()
                  ) {
                    event.preventDefault();
                    replaceValue(visibleSuggestions[activeSuggestion].value);
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (hasValidProperty) {
                      submit(currentInput);
                      return;
                    }
                    if (visibleSuggestions.length) {
                      replaceValue(visibleSuggestions[activeSuggestion].value);
                      return;
                    }
                    submit(currentInput);
                  }
                }}
              />
            )}
            placeholder={(
              <span className="pointer-events-none absolute left-3 top-2 font-mono text-xs text-[var(--text-tertiary)]">
                priority:: high
              </span>
            )}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <OnChangePlugin
            onChange={(editorState: EditorState) => {
              editorState.read(() => {
                setValue($getRoot().getTextContent());
                setActiveSuggestion(0);
                setSuggestionsOpen(true);
              });
            }}
          />
          <HistoryPlugin />
          {autoFocus || editorKey > 0 ? <AutoFocusPlugin /> : null}
        </div>
      </LexicalComposer>
      {visibleSuggestions.length ? (
        <div
          id={suggestionsId}
          role="listbox"
          aria-label="Property suggestions"
          className="max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1 shadow-xl"
        >
          {visibleSuggestions.map((suggestion, index) => (
            <button
              key={suggestion.value}
              id={`${suggestionsId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeSuggestion}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => replaceValue(suggestion.value)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] aria-selected:bg-[var(--accent-muted)]"
            >
              <span className="font-mono text-[var(--accent-300)]">{suggestion.label}</span>
              <span className="ml-auto text-[10px] text-[var(--text-tertiary)]">{suggestion.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-[11px] text-red-400">{error}</p> : null}
      <p className="text-[10px] text-[var(--text-tertiary)]">
        Enter saves. Arrow keys browse suggestions; Tab completes.
      </p>
    </div>
  );
}
