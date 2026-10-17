import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  TagSuggestionReviewCard,
  type EditableTagSuggestion,
} from '@/components/ai/TagSuggestionReviewCard';

const suggestion: EditableTagSuggestion = {
  taskId: 'task-1',
  title: 'Prepare launch checklist',
  confidence: 0.8,
  tags: [
    { id: 'tag-launch', name: 'Launch', confidence: 0.92, reason: 'Title match' },
    { id: 'tag-release', name: 'Release', confidence: 0.68, reason: 'List pattern' },
  ],
  suggestedTagIds: ['tag-launch', 'tag-release'],
  selectedTagIds: ['tag-launch', 'tag-release'],
};

describe('TagSuggestionReviewCard', () => {
  it('supports selecting and removing individual recommendations', () => {
    const onChange = vi.fn();
    render(
      <TagSuggestionReviewCard
        suggestion={suggestion}
        availableTags={[]}
        applying={false}
        onChange={onChange}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(onChange).toHaveBeenCalledWith({
      ...suggestion,
      selectedTagIds: ['tag-launch'],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Launch' }));
    expect(onChange).toHaveBeenCalledWith({
      ...suggestion,
      tags: [suggestion.tags[1]],
      selectedTagIds: ['tag-release'],
    });
  });

  it('adds an existing tag and exposes the selected apply count', () => {
    const onChange = vi.fn();
    const onApply = vi.fn();
    render(
      <TagSuggestionReviewCard
        suggestion={suggestion}
        availableTags={[{ id: 'tag-web', name: 'Web' }]}
        applying={false}
        onChange={onChange}
        onApply={onApply}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Add another tag'));
    fireEvent.click(screen.getByRole('option', { name: 'Web' }));
    expect(onChange).toHaveBeenCalledWith({
      ...suggestion,
      tags: [
        ...suggestion.tags,
        { id: 'tag-web', name: 'Web', confidence: 1, reason: 'Added manually' },
      ],
      selectedTagIds: ['tag-launch', 'tag-release', 'tag-web'],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 tags' }));
    expect(onApply).toHaveBeenCalledOnce();
  });
});
