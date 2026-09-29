import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchInput } from '@/components/ui/SearchInput';

function ControlledSearchInput({ loading = false }: { loading?: boolean }) {
  const [value, setValue] = useState('project');

  return (
    <SearchInput
      value={value}
      onChange={setValue}
      placeholder="Search projects"
      clearLabel="Clear project search"
      loading={loading}
    />
  );
}

describe('SearchInput', () => {
  it('clears the value and restores focus to the input', () => {
    render(<ControlledSearchInput />);

    const input = screen.getByRole('textbox', { name: 'Search projects' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear project search' }));

    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear project search' })).not.toBeInTheDocument();
  });

  it('keeps the clear action available while results are loading', () => {
    render(<ControlledSearchInput loading />);

    expect(screen.getByLabelText('Searching')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear project search' })).toBeInTheDocument();
  });

  it('supports external focus refs and keyboard handlers', () => {
    const inputRef = createRef<HTMLInputElement>();
    const onKeyDown = vi.fn();

    render(
      <SearchInput
        ref={inputRef}
        value=""
        onChange={vi.fn()}
        placeholder="Search"
        onKeyDown={onKeyDown}
      />,
    );

    inputRef.current?.focus();
    fireEvent.keyDown(inputRef.current as HTMLInputElement, { key: 'Enter' });

    expect(inputRef.current).toHaveFocus();
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});
