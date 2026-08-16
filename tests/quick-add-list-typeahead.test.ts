import { describe, expect, it, vi } from 'vitest';
import { scrollListTypeaheadSelectionIntoView } from '@/components/add-task/QuickAddBar';

describe('quick-add list typeahead', () => {
  it('scrolls the keyboard-selected option into view', () => {
    const container = document.createElement('div');
    const option = document.createElement('button');
    option.dataset.listTypeaheadIndex = '7';
    option.scrollIntoView = vi.fn();
    container.append(option);

    scrollListTypeaheadSelectionIntoView(container, 7);

    expect(option.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});
