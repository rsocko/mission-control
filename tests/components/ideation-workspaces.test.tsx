import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdeationWorkspaceBar } from '@/components/ideation/IdeationWorkspaceBar';
import { createIdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';
import type { IdeationWorkspace } from '@/lib/graph-workspace/types';
import { useIdeationStore } from '@/lib/stores/ideationStore';

function workspace(
  id: string,
  name: string,
  revision = 1,
  label = name,
): IdeationWorkspace {
  const now = '2026-08-14T20:00:00.000Z';
  return {
    id,
    name,
    type: 'ideation',
    schemaVersion: 1,
    contentRevision: revision,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    document: createIdeationWorkspaceDocument([{
      id: `${id}-root`,
      label,
      kind: 'idea',
      parentId: null,
      sortOrder: 0,
      properties: {},
    }]),
  };
}

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

describe('IdeationWorkspaceBar', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useIdeationStore.setState({
      nodes: workspace('initial', 'Initial').document.nodes,
      selectedNodeId: null,
      workspaceId: null,
      workspaceRevision: null,
      flushWorkspace: null,
      past: [],
    });
  });

  it('migrates the legacy local draft only after retaining a recovery copy', async () => {
    const recovered = workspace('workspace-recovered', 'Recovered Ideation');
    const legacy = JSON.stringify({
      state: { nodes: recovered.document.nodes },
      version: 0,
    });
    localStorage.setItem('mission-control:ideation', legacy);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/ideation/workspaces' && init?.method === 'POST') {
        expect(localStorage.getItem('mission-control:ideation:recovery')).toBe(legacy);
        return response({ workspace: recovered }, 201);
      }
      if (url.includes('includeArchived=true')) {
        return response({ workspaces: [recovered] });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IdeationWorkspaceBar />);

    expect(await screen.findByText('Recovered Ideation')).toBeInTheDocument();
    expect(localStorage.getItem('mission-control:ideation')).toBeNull();
    expect(localStorage.getItem('mission-control:ideation:recovery')).toBe(legacy);
    expect(localStorage.getItem('mission-control:ideation:migrated'))
      .toBe('workspace-recovered');
  });

  it('serializes autosaves and advances the active workspace revision', async () => {
    const original = workspace('workspace-one', 'One');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('includeArchived=true')) {
        return response({ workspaces: [original] });
      }
      if (url === '/api/ideation/workspaces/workspace-one' && !init?.method) {
        return response({ workspace: original });
      }
      if (url === '/api/ideation/workspaces/workspace-one' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as {
          baseRevision: number;
          document: ReturnType<typeof createIdeationWorkspaceDocument>;
        };
        expect(body.baseRevision).toBe(1);
        expect(body.document.nodes).toHaveLength(2);
        return response({
          workspace: {
            ...original,
            contentRevision: 2,
            document: body.document,
          },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<IdeationWorkspaceBar />);
    expect(await screen.findByText('One')).toBeInTheDocument();

    act(() => {
      useIdeationStore.getState().addNode('workspace-one-root', 'task', 'Persist me');
    });

    await waitFor(() => expect(useIdeationStore.getState().workspaceRevision).toBe(2), {
      timeout: 2500,
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });

  it('defers autosave while a title is temporarily empty instead of crashing', async () => {
    const original = workspace('workspace-one', 'One');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('includeArchived=true')) {
        return response({ workspaces: [original] });
      }
      if (url === '/api/ideation/workspaces/workspace-one' && !init?.method) {
        return response({ workspace: original });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<IdeationWorkspaceBar />);
    expect(await screen.findByText('One')).toBeInTheDocument();

    act(() => {
      useIdeationStore.getState().updateLabel('workspace-one-root', '');
    });

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Needs attention'));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  it('preserves a conflicted local draft as a new active workspace', async () => {
    const original = workspace('workspace-one', 'One');
    const remote = workspace('workspace-one', 'One', 2, 'Remote edit');
    const copy = workspace('workspace-copy', 'One (recovered copy)', 1, 'One');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('includeArchived=true')) {
        return response({ workspaces: [original] });
      }
      if (url === '/api/ideation/workspaces/workspace-one' && !init?.method) {
        return response({ workspace: original });
      }
      if (url === '/api/ideation/workspaces/workspace-one' && init?.method === 'PATCH') {
        return response({
          error: 'This workspace changed in another tab or client.',
          code: 'WORKSPACE_CONFLICT',
          current: remote,
        }, 409);
      }
      if (url === '/api/ideation/workspaces' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          document: IdeationWorkspace['document'];
        };
        expect(body.document.nodes.some((node) => node.label === 'Local edit')).toBe(true);
        return response({
          workspace: { ...copy, document: body.document },
        }, 201);
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<IdeationWorkspaceBar />);
    expect(await screen.findByText('One')).toBeInTheDocument();

    act(() => {
      useIdeationStore.getState().addNode('workspace-one-root', 'task', 'Local edit');
    });
    expect(await screen.findByText('Workspace changed elsewhere', {}, { timeout: 2500 }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save local copy/i }));

    await waitFor(() => expect(useIdeationStore.getState().workspaceId).toBe('workspace-copy'));
    expect(useIdeationStore.getState().nodes.some((node) => node.label === 'Local edit')).toBe(true);
  });
});
