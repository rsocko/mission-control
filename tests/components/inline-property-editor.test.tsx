import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlinePropertyEditor } from '@/components/ideation/InlinePropertyEditor';

describe('InlinePropertyEditor', () => {
  it('clears visible editor content after a typed property is submitted', async () => {
    const onSubmit = vi.fn();
    render(<InlinePropertyEditor onSubmit={onSubmit} />);
    const editor = screen.getByLabelText('Inline property');

    editor.textContent = 'priority:: high';
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        key: 'priority',
        value: 'high',
      }));
      expect(editor).toHaveTextContent('');
    });

  });

  it('provides keyboard-accessible property and value typeahead', async () => {
    render(<InlinePropertyEditor draft="pri" onSubmit={vi.fn()} />);
    const editor = screen.getByLabelText('Inline property');

    expect(screen.getByRole('listbox', { name: 'Property suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /priority/ })).toHaveAttribute('aria-selected', 'true');
    expect(editor).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: /priority/ }).id,
    );
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByLabelText('Inline property')).toHaveTextContent('priority::');
      expect(screen.getByLabelText('Inline property')).toHaveFocus();
    });
    expect(screen.getByLabelText('Inline property')).toHaveAttribute('aria-autocomplete', 'list');
  });

  it('surfaces invalid input as an accessible error', async () => {
    render(<InlinePropertyEditor draft="effort:: 9" onSubmit={vi.fn()} />);
    fireEvent.keyDown(screen.getByLabelText('Inline property'), { key: 'Enter' });

    expect(await screen.findByRole('alert')).toHaveTextContent('1 to 5');
  });

  it('suggests ideation node titles for relationship values', () => {
    render(
      <InlinePropertyEditor
        draft="related:: Fir"
        nodeLabels={['First task', 'Second task']}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: /First task/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Second task/ })).not.toBeInTheDocument();
  });

  it('preserves existing links when completing another relationship target', async () => {
    render(
      <InlinePropertyEditor
        draft="related:: [[First task]], [[Sec"
        nodeLabels={['First task', 'Second task']}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('option', { name: /Second task/ }));

    await waitFor(() => {
      expect(screen.getByLabelText('Inline property')).toHaveTextContent(
        'related:: [[First task]], [[Second task]]',
      );
    });
  });

  it('dismisses typeahead without requiring the surrounding editor to close', () => {
    render(<InlinePropertyEditor draft="pri" onSubmit={vi.fn()} />);
    const editor = screen.getByLabelText('Inline property');

    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(screen.queryByRole('listbox', { name: 'Property suggestions' })).not.toBeInTheDocument();
    expect(editor).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor).toHaveTextContent('pri');
  });
});
