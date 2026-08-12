import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskContextMenu, type TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import { MobileTaskActions } from '@/components/task-list/MobileTaskActions';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const actions: TaskContextMenuActions = {
  onComplete: vi.fn(),
  onSetPriority: vi.fn(),
  onDueToday: vi.fn(),
  onDueTomorrow: vi.fn(),
  onPickDate: vi.fn(),
  onDelete: vi.fn(),
};

describe('TaskContextMenu date picker', () => {
  it('releases the modal pointer lock after outside dismissal', async () => {
    render(
      <TaskContextMenu
        task={{
          id: 'task-1',
          title: 'Test task',
          priority: 'none',
          connectorType: 'local',
          dueDate: null,
          localDisposition: 'active',
          taskSourceModel: 'mc-owned',
          editPolicy: editableTaskPolicy,
        }}
        actions={actions}
      >
        <button type="button">Task row</button>
      </TaskContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Task row' }), {
      clientX: 100,
      clientY: 100,
    });

    fireEvent.click(await screen.findByText('Pick a date…'));

    const dialog = await screen.findByRole('dialog', { name: 'Pick a due date' });
    const overlay = dialog.previousElementSibling;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay!, { button: 0, pointerType: 'mouse' });
    fireEvent.click(overlay!);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Pick a due date' })).toBeNull();
      expect(document.body.style.pointerEvents).not.toBe('none');
    });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Task row' }), {
      clientX: 100,
      clientY: 100,
    });
    expect(await screen.findByText('Pick a date…')).toBeDefined();
  });
});

describe('TaskContextMenu local disposition', () => {
  it('offers disabled-connector mirrors local-only disposition actions on desktop', async () => {
    const onSetLocalDisposition = vi.fn();
    render(
      <TaskContextMenu
        task={{
          id: 'mirror-1',
          title: 'Read-only issue',
          priority: 'none',
          connectorType: 'github-issues',
          dueDate: null,
          localDisposition: 'active',
          taskSourceModel: 'remote-mirror',
          editPolicy: makeTaskEditPolicy({
            sourceModel: 'remote-mirror',
            connectorEnabled: false,
          }),
        }}
        actions={{ ...actions, onSetLocalDisposition }}
      >
        <button type="button">Mirror row</button>
      </TaskContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Mirror row' }));
    fireEvent.keyDown(await screen.findByText('Mission Control state'), { key: 'ArrowRight' });
    expect(await screen.findByText('These actions do not change the upstream task.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /Mark handled here/i }));
    expect(onSetLocalDisposition).toHaveBeenCalledWith('handled');
  });

  it('exposes the same local-only actions in the mobile action sheet', () => {
    const onSetLocalDisposition = vi.fn();
    render(
      <MobileTaskActions
        isOpen
        onClose={vi.fn()}
        task={{
          id: 'mirror-1',
          title: 'Read-only issue',
          priority: 'none',
          connectorType: 'github-issues',
          dueDate: null,
          localDisposition: 'active',
          taskSourceModel: 'remote-mirror',
          editPolicy: makeTaskEditPolicy({ sourceModel: 'remote-mirror' }),
        }}
        actions={{ ...actions, onSetLocalDisposition }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mission Control state' }));
    expect(screen.getByText('Mission Control only. The upstream task is unchanged.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Dismiss here/i }));
    expect(onSetLocalDisposition).toHaveBeenCalledWith('dismissed');
  });
});

describe('TaskContextMenu project phase picker', () => {
  it('shows the current phase and allows selecting another phase in the same project', async () => {
    const onAddToProject = vi.fn();
    render(
      <TaskContextMenu
        task={{
          id: 'task-1',
          title: 'Test task',
          priority: 'none',
          connectorType: 'local',
          dueDate: null,
          localDisposition: 'active',
          taskSourceModel: 'mc-owned',
          editPolicy: editableTaskPolicy,
        }}
        projects={[{
          id: 'project-1',
          name: 'Website',
          color: '#3b82f6',
          phases: [
            { id: 'phase-planning', name: 'Planning' },
            { id: 'phase-delivery', name: 'Delivery' },
          ],
        }]}
        taskProjectIds={['project-1']}
        taskProjectPhaseMemberships={[{
          projectId: 'project-1',
          phaseId: 'phase-delivery',
          phaseName: 'Delivery',
        }]}
        actions={{ ...actions, onAddToProject }}
      >
        <button type="button">Task row</button>
      </TaskContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Task row' }));
    fireEvent.keyDown(await screen.findByText('More…'), { key: 'ArrowRight' });
    fireEvent.keyDown(await screen.findByText('Add to project…'), { key: 'ArrowRight' });

    expect(await screen.findByText('Delivery')).toBeDefined();
    fireEvent.keyDown(await screen.findByText('Website'), { key: 'ArrowRight' });
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Delivery', checked: true })).toBeDefined();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Planning', checked: false })).toBeDefined();
    expect(screen.getByRole('menuitemcheckbox', { name: 'No phase', checked: false })).toBeDefined();
    fireEvent.click(await screen.findByText('Planning'));

    expect(onAddToProject).toHaveBeenCalledWith('project-1', 'phase-planning');
  });

  it('exposes the selected phase to assistive technology on mobile', async () => {
    render(
      <MobileTaskActions
        isOpen
        onClose={vi.fn()}
        task={{
          id: 'task-1',
          title: 'Test task',
          priority: 'none',
          connectorType: 'local',
          dueDate: null,
          localDisposition: 'active',
          taskSourceModel: 'mc-owned',
          editPolicy: editableTaskPolicy,
        }}
        projects={[{
          id: 'project-1',
          name: 'Website',
          color: '#3b82f6',
          phases: [
            { id: 'phase-planning', name: 'Planning' },
            { id: 'phase-delivery', name: 'Delivery' },
          ],
        }]}
        taskProjectIds={['project-1']}
        taskProjectPhaseMemberships={[{
          projectId: 'project-1',
          phaseId: 'phase-delivery',
          phaseName: 'Delivery',
        }]}
        actions={{ ...actions, onAddToProject: vi.fn() }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add to project…' }));

    expect(await screen.findByRole('button', { name: 'Delivery', pressed: true })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Planning', pressed: false })).toBeDefined();
    expect(screen.getByRole('button', { name: 'No phase', pressed: false })).toBeDefined();
  });
});
