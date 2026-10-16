import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  QuickAddSuggestionReview,
  type QuickAddSuggestionSelection,
} from '@/components/add-task/QuickAddSuggestionReview';

const suggestion = {
  priority: { value: 'high', confidence: 0.8, reason: 'Urgent language' },
  effort: { value: 2, confidence: 0.5, reason: 'Likely a short task' },
  tags: [
    { id: 'tag-release', name: 'Release', confidence: 0.9 },
    { id: 'tag-web', name: 'Web', confidence: 0.6 },
    { id: 'tag-maybe', name: 'Maybe', confidence: 0.2 },
  ],
  projects: [{
    id: 'project-launch',
    name: 'Launch',
    color: 'blue',
    confidence: 0.67,
    reason: '2 of 3 items on this source',
  }],
};

const projects = [{
  id: 'project-launch',
  name: 'Launch',
  phases: [
    { id: 'phase-discovery', name: 'Discovery' },
    { id: 'phase-ready', name: 'Launch readiness' },
  ],
}];

describe('Quick Add suggestion review', () => {
  it('preselects strong suggestions while leaving plausible suggestions opt-in', async () => {
    const onApply = vi.fn<(selection: QuickAddSuggestionSelection) => Promise<void>>()
      .mockResolvedValue(undefined);

    render(
      <QuickAddSuggestionReview
        suggestion={suggestion}
        taskTitle="Finish launch readiness checklist"
        projects={projects}
        availableTags={[]}
        applying={false}
        onAvailableTagsChange={vi.fn()}
        onApply={onApply}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Apply priority suggestion' }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'Apply effort suggestion' }))
      .toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('checkbox', { name: 'Apply project suggestion' }))
      .toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Release' }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Web' }))
      .toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Maybe')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+1 more' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply selected' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith({
      priority: 'high',
      tagNames: ['Release'],
    }));
  });

  it('re-evaluates phase choices when the project changes and supports skipping by keyboard', () => {
    const onSkip = vi.fn();
    render(
      <QuickAddSuggestionReview
        suggestion={suggestion}
        taskTitle="Finish launch readiness checklist"
        projects={[
          ...projects,
          {
            id: 'project-other',
            name: 'Other',
            phases: [{ id: 'phase-build', name: 'Build' }],
          },
        ]}
        availableTags={[]}
        applying={false}
        onAvailableTagsChange={vi.fn()}
        onApply={vi.fn().mockResolvedValue(undefined)}
        onSkip={onSkip}
      />,
    );

    expect(screen.getByLabelText('Phase')).toHaveValue('phase-ready');
    fireEvent.change(screen.getByLabelText('Project'), {
      target: { value: 'project-other' },
    });
    expect(screen.getByLabelText('Phase')).toHaveValue('');

    const review = screen.getByText('Review suggestions').parentElement?.parentElement;
    expect(review).not.toBeNull();
    fireEvent.keyDown(review!, { key: 'Escape' });
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
