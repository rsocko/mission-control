import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { TooltipProvider } from '@/components/ui/Tooltip';

function selectText(textarea: HTMLTextAreaElement, start: number, end: number) {
  textarea.focus();
  textarea.setSelectionRange(start, end);
}

function renderEditor(value: string, onValueChange: (value: string) => void) {
  render(
    <TooltipProvider>
      <MarkdownEditor value={value} onValueChange={onValueChange} />
    </TooltipProvider>,
  );
}

describe('MarkdownEditor', () => {
  it('wraps a single-line code selection in inline backticks', () => {
    const onValueChange = vi.fn();
    renderEditor('Run npm test now', onValueChange);
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
    selectText(textarea, 4, 12);

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));

    expect(onValueChange).toHaveBeenCalledWith('Run `npm test` now');
  });

  it('wraps a multiline code selection in a fenced code block', () => {
    const onValueChange = vi.fn();
    const value = 'Before\nconst one = 1;\nconst two = 2;\nAfter';
    renderEditor(value, onValueChange);
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
    const start = value.indexOf('const one');
    const end = value.indexOf('\nAfter');
    selectText(textarea, start, end);

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));

    expect(onValueChange).toHaveBeenCalledWith(
      'Before\n```\nconst one = 1;\nconst two = 2;\n```\nAfter',
    );
  });

  it('puts multiline code fences on their own lines for a partial-line selection', () => {
    const onValueChange = vi.fn();
    const value = 'Before const one = 1;\nconst two = 2; after';
    renderEditor(value, onValueChange);
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
    const start = value.indexOf('const one');
    const end = value.indexOf(' after');
    selectText(textarea, start, end);

    fireEvent.click(screen.getByRole('button', { name: 'Code' }));

    expect(onValueChange).toHaveBeenCalledWith(
      'Before \n```\nconst one = 1;\nconst two = 2;\n```\n after',
    );
  });
});
