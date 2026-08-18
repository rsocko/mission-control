import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdeationConvertDialog } from '@/components/ideation/IdeationConvertDialog';
import { IdeationPropertyPanel } from '@/components/ideation/IdeationPropertyPanel';
import { useIdeationStore } from '@/lib/stores/ideationStore';

describe('ideation rendering parts', () => {
  beforeEach(() => {
    useIdeationStore.setState({
      nodes: [{
        id: 'root',
        label: 'Launch plan',
        kind: 'idea',
        parentId: null,
        sortOrder: 0,
        properties: {},
      }],
      selectedNodeId: 'root',
      workspaceId: null,
      workspaceRevision: null,
      flushWorkspace: null,
      past: [],
    });
  });

  it('renders and synchronizes the property panel independently', () => {
    render(<IdeationPropertyPanel />);

    expect(screen.getByRole('heading', { name: 'Node properties' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Launch plan')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close properties' }));
    expect(useIdeationStore.getState().selectedNodeId).toBeNull();
  });

  it('renders the conversion dialog independently', () => {
    render(<IdeationConvertDialog onClose={() => {}} />);

    expect(screen.getByRole('dialog', { name: 'Convert to project' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Launch plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
  });
});
