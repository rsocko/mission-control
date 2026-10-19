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
    expect(screen.getByText('1 of 3 selected. Only selected tags will be applied.'))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 low-confidence tag' }));
    expect(screen.getByRole('button', { name: 'Maybe' }))
      .toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Apply selected' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith({
      priority: 'high',
      tagNames: ['Release'],
    }));
  });

  it('shows low-confidence priority as an explicit opt-in suggestion', () => {
    render(
      <QuickAddSuggestionReview
        suggestion={{
          priority: {
            value: 'low',
            confidence: 0.25,
            reason: 'No urgency signals detected',
          },
          effort: null,
          tags: [],
          projects: [],
        }}
        taskTitle="Archive old notes"
        projects={[]}
        availableTags={[]}
        applying={false}
        onAvailableTagsChange={vi.fn()}
        onApply={vi.fn().mockResolvedValue(undefined)}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Suggested priority')).toHaveTextContent('P3');
    expect(screen.getByText('25% · low')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Apply priority suggestion' }))
      .toHaveAttribute('aria-checked', 'false');
  });

  it('selects priority and effort for application when their values change', async () => {
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

    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply priority suggestion' }));
    expect(screen.getByRole('checkbox', { name: 'Apply priority suggestion' }))
      .toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByLabelText('Suggested priority'));
    const lowPriorityOption = screen.getByRole('option', { name: 'P3 · Low' });
    expect(lowPriorityOption).toHaveClass('text-sky-400');
    fireEvent.click(lowPriorityOption);
    expect(screen.getByRole('checkbox', { name: 'Apply priority suggestion' }))
      .toHaveAttribute('aria-checked', 'true');

    expect(screen.getByRole('checkbox', { name: 'Apply effort suggestion' }))
      .toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByLabelText('Suggested effort'));
    const largeEffortOption = screen.getByRole('option', { name: 'L' });
    expect(largeEffortOption.querySelector('.bg-orange-400')).toBeInTheDocument();
    fireEvent.click(largeEffortOption);
    expect(screen.getByRole('checkbox', { name: 'Apply effort suggestion' }))
      .toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Apply selected' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith({
      priority: 'low',
      effort: 4,
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

    expect(screen.getByLabelText('Phase')).toHaveTextContent('Launch readiness');
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), {
      target: { value: 'oth' },
    });
    expect(screen.queryByRole('option', { name: 'Launch' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Other' }));
    expect(screen.getByRole('checkbox', { name: 'Apply project suggestion' }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Phase')).toHaveTextContent('No phase');
    fireEvent.click(screen.getByLabelText('Phase'));
    fireEvent.click(screen.getByRole('option', { name: 'Build' }));
    expect(screen.getByRole('checkbox', { name: 'Apply phase suggestion' }))
      .toHaveAttribute('aria-checked', 'true');

    const review = screen.getByText('Review suggestions').parentElement?.parentElement;
    expect(review).not.toBeNull();
    fireEvent.keyDown(review!, { key: 'Escape' });
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
