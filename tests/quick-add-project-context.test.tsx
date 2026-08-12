import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getQuickAddProjectAffordance,
  getVisibleQuickAddProject,
  QuickAddProjectControl,
  resolveQuickAddProjectId,
  syncQuickAddProjectActive,
} from '@/components/add-task/QuickAddBar';
import { TooltipProvider } from '@/components/ui/Tooltip';

describe('quick-add project context', () => {
  it('only exposes a project default when its affordance can include a name', () => {
    expect(getVisibleQuickAddProject('project-1', null)).toBeNull();
    expect(getVisibleQuickAddProject('project-1', '  ')).toBeNull();
    expect(getVisibleQuickAddProject(null, 'Website refresh')).toBeNull();
    expect(getVisibleQuickAddProject('project-1', ' Website refresh ')).toEqual({
      id: 'project-1',
      name: 'Website refresh',
    });
  });

  it('uses the visible active project as the default', () => {
    const project = getVisibleQuickAddProject('project-1', 'Website refresh');

    expect(resolveQuickAddProjectId(null, project, true)).toBe('project-1');
  });

  it('does not assign a hidden or dismissed project', () => {
    const project = getVisibleQuickAddProject('project-1', 'Website refresh');

    expect(resolveQuickAddProjectId(null, project, false)).toBeUndefined();
    expect(resolveQuickAddProjectId(null, null, true)).toBeUndefined();
  });

  it('lets an explicit project token override the contextual default', () => {
    const project = getVisibleQuickAddProject('project-1', 'Website refresh');

    expect(resolveQuickAddProjectId('project-2', project, true)).toBe('project-2');
  });

  it('describes active project assignment as an outcome, not a default', () => {
    expect(getQuickAddProjectAffordance('Website refresh', true)).toEqual({
      ariaLabel: 'Adding tasks to project Website refresh. Click to remove.',
      tooltip: 'New tasks will be added to Website refresh. Click to remove.',
    });
  });

  it('describes inactive project assignment as an explicit action', () => {
    expect(getQuickAddProjectAffordance('Website refresh', false)).toEqual({
      ariaLabel: 'Add new tasks to project Website refresh',
      tooltip: 'Add new tasks to Website refresh',
    });
  });

  it('supports click activation used by mouse and keyboard controls', () => {
    const onActiveChange = vi.fn();
    render(
      <TooltipProvider>
        <QuickAddProjectControl
          project={{ id: 'project-1', name: 'Website refresh' }}
          active={false}
          onActiveChange={onActiveChange}
        />
      </TooltipProvider>,
    );

    const control = screen.getByRole('button', {
      name: 'Add new tasks to project Website refresh',
    });
    control.focus();
    fireEvent.click(control);

    expect(onActiveChange).toHaveBeenCalledWith(true);
  });

  it('preserves dismissal when the current project name changes', () => {
    expect(syncQuickAddProjectActive('project-1', 'project-1', false)).toBe(false);
  });

  it('activates on entry and clears on exit or a project change', () => {
    expect(syncQuickAddProjectActive(null, 'project-1', false)).toBe(true);
    expect(syncQuickAddProjectActive('project-1', null, true)).toBe(false);
    expect(syncQuickAddProjectActive('project-1', 'project-2', false)).toBe(true);
  });
});
