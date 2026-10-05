import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionDestinationsSection } from '@/app/settings/components/ExecutionDestinationsSection';

function response(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ExecutionDestinationsSection', () => {
  it('shows a retryable load error instead of a false empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({ error: 'Registry unavailable' }, 503)));

    render(<ExecutionDestinationsSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Registry unavailable');
    expect(screen.getByText('Scout status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No direct execution destinations yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Retry loading execution destinations',
    })).toBeInTheDocument();
  });

  it('accepts a GitHub token directly and reports server-side storage', async () => {
    let requestBody: Record<string, unknown> | null = null;
    let created = false;
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/external-agents' && init?.method === 'POST') {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        created = true;
        return response({ agent: { id: 'github-cloud' } }, 201);
      }
      if (url === '/api/external-agents' && !init?.method) {
        return response({ agents: created ? [{
          id: 'github-cloud',
          name: 'GitHub Copilot Cloud',
          type: 'copilot-cloud',
          description: null,
          endpoint: 'https://api.github.com/',
          authType: 'github-user',
          providerConfig: {},
          capabilities: { canAnalyzeCode: true, canWriteCode: true },
          dataPolicy: {
            allowedClassifications: ['standard'],
            fieldAllowlist: ['instruction'],
            retentionDays: 30,
            maxRequestsPerMinute: 30,
          },
          enabled: true,
          executionLocality: 'github-hosted',
          hasCredentialReference: true,
          credentialSource: 'mission-control',
          updatedAt: '2026-10-03T00:00:00.000Z',
        }] : [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<ExecutionDestinationsSection />);

    expect(await screen.findByText('No direct execution destinations yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GitHub Copilot Cloud' }));
    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: 'github_pat_test-value' },
    });
    fireEvent.change(screen.getByLabelText('Always instructions'), {
      target: { value: 'Run the repository tests before handoff.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));

    await waitFor(() => expect(requestBody).not.toBeNull());
    expect(requestBody).toMatchObject({
      name: 'GitHub Copilot Cloud',
      type: 'copilot-cloud',
      endpoint: 'https://api.github.com',
      authType: 'github-user',
      credential: 'github_pat_test-value',
      providerConfig: {
        alwaysInstructions: 'Run the repository tests before handoff.',
      },
      dataPolicy: { allowedClassifications: ['standard'] },
    });
    expect(requestBody).not.toHaveProperty('authCredentialRef');
    expect(await screen.findByText(/Personal access token stored in Mission Control/))
      .toBeInTheDocument();
  });

  it('submits setup-bound Paperclip route fields for validation', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/external-agents' && init?.method === 'POST') {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ agent: { id: 'paperclip-route' } }, 201);
      }
      if (url === '/api/external-agents' && !init?.method) {
        return response({ agents: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<ExecutionDestinationsSection />);
    expect(await screen.findByText('No direct execution destinations yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Paperclip route' }));
    fireEvent.change(screen.getByLabelText('Paperclip API origin'), {
      target: { value: 'http://localhost:3100' },
    });

    fireEvent.change(screen.getByLabelText('Company ID'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Project ID'), {
      target: { value: '22222222-2222-4222-8222-222222222222' },
    });
    fireEvent.change(screen.getByLabelText('Assignee agent ID'), {
      target: { value: '33333333-3333-4333-8333-333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Required adapter type'), {
      target: { value: 'claude-local' },
    });
    fireEvent.change(screen.getByLabelText('Always instructions'), {
      target: { value: 'Post concise progress updates.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));

    await waitFor(() => expect(requestBody).not.toBeNull());
    expect(requestBody).toMatchObject({
      type: 'paperclip',
      endpoint: 'http://localhost:3100',
      authType: 'none',
      authCredentialRef: null,
      providerConfig: {
        alwaysInstructions: 'Post concise progress updates.',
        paperclip: {
          companyId: '11111111-1111-4111-8111-111111111111',
          projectId: '22222222-2222-4222-8222-222222222222',
          assigneeAgentId: '33333333-3333-4333-8333-333333333333',
          requiredAdapterType: 'claude-local',
        },
      },
    });
  });

  it('shows configured Scout pickup and can disable it from AI settings', async () => {
    let disabled = false;
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/external-agents') return response({ agents: [] });
      if (url === '/api/connectors') {
        return response({
          connectors: [{ id: 'scout-primary', type: 'scout', name: 'Scout', enabled: true }],
        });
      }
      if (url === '/api/scout/worker?connectorId=scout-primary') {
        return response({
          worker: {
            id: 'scout-pull-worker-scout-primary',
            name: 'Scout work pickup',
            enabled: true,
          },
        });
      }
      if (url === '/api/scout/worker' && init?.method === 'POST') {
        disabled = true;
        return response({
          worker: {
            id: 'scout-pull-worker-scout-primary',
            name: 'Scout work pickup',
            enabled: false,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<ExecutionDestinationsSection />);

    expect(await screen.findByText('Pickup enabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Scout work pickup' }));

    await waitFor(() => expect(disabled).toBe(true));
    expect(await screen.findByText('Pickup off')).toBeInTheDocument();
  });

  it('reveals the required Scout setup prompt when pickup is enabled', async () => {
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/external-agents') return response({ agents: [] });
      if (url === '/api/connectors') {
        return response({
          connectors: [{ id: 'scout-primary', type: 'scout', name: 'Scout', enabled: true }],
        });
      }
      if (url === '/api/scout/worker?connectorId=scout-primary') {
        return response({ worker: null });
      }
      if (url === '/api/scout/worker' && init?.method === 'POST') {
        return response({
          worker: {
            id: 'scout-pull-worker-scout-primary',
            name: 'Scout work pickup',
            enabled: true,
          },
          setupPrompt: 'Configure Scout to claim Mission Control work.',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<ExecutionDestinationsSection />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable Scout work pickup' }));

    expect(await screen.findByText('Finish setup in Scout')).toBeInTheDocument();
    expect(screen.getByText('Configure Scout to claim Mission Control work.')).toBeInTheDocument();
  });

  it('keeps an existing hidden credential reference while editing', async () => {
    let patchBody: Record<string, unknown> | null = null;
    let getCount = 0;
    const destination = {
      id: 'github-cloud',
      name: 'GitHub Copilot Cloud',
      type: 'copilot-cloud',
      description: null,
      endpoint: 'https://api.github.com/',
      authType: 'github-user',
      providerConfig: {
        alwaysInstructions: 'Preserve this server-owned policy.',
      },
      capabilities: { canAnalyzeCode: true },
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: [
          'instruction',
          'alwaysInstructions',
          'tasks.id',
          'tasks.title',
          'tasks.description',
          'tasks.subtasks',
          'tasks.sourceIssue',
        ],
        retentionDays: 30,
        maxRequestsPerMinute: 30,
      },
      enabled: true,
      executionLocality: 'github-hosted',
      hasCredentialReference: true,
      credentialSource: 'mission-control',
      updatedAt: '2026-10-03T00:00:00.000Z',
    };
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/external-agents/github-cloud' && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({ agent: destination });
      }
      if (url === '/api/external-agents' && !init?.method) {
        getCount += 1;
        return response({ agents: [destination] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<ExecutionDestinationsSection />);
    expect(await screen.findByText(/Personal access token stored in Mission Control/))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit GitHub Copilot Cloud' }));
    expect(screen.getByLabelText('Personal access token')).toHaveAttribute(
      'placeholder',
      'Current token is hidden',
    );
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Primary coding route' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save destination' }));

    await waitFor(() => expect(patchBody).not.toBeNull());
    expect(patchBody).not.toHaveProperty('authCredentialRef');
    expect(patchBody).not.toHaveProperty('credential');
    expect(patchBody).toMatchObject({
      providerConfig: {
        alwaysInstructions: 'Preserve this server-owned policy.',
      },
      dataPolicy: {
        allowedClassifications: ['standard'],
      },
    });
    expect(getCount).toBeGreaterThanOrEqual(2);
  });
});
