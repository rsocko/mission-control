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
  it('uses destination brand marks for setup actions and Scout', async () => {
    const fetcher = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/external-agents') return response({ agents: [] });
      if (url === '/api/connectors') return response({ connectors: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<ExecutionDestinationsSection />);

    expect(await screen.findByText('No direct execution destinations yet')).toBeInTheDocument();

    const paperclipButton = screen.getByRole('button', { name: 'Paperclip route' });
    expect(paperclipButton.querySelector('svg path')).toHaveAttribute(
      'd',
      'm16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551',
    );

    const githubButton = screen.getByRole('button', { name: 'GitHub Copilot Cloud' });
    expect(githubButton.querySelector('img')).toHaveAttribute(
      'src',
      '/icons/connectors/github.svg',
    );

    expect(screen.getByAltText('dash:microsoft-copilot')).toHaveAttribute(
      'src',
      'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-copilot.svg',
    );
  });

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
    expect(screen.getByText(/Agent tasks — Read and write/)).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.tagName === 'LI' && element.textContent === 'Account permissions: None.'))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create fine-grained token/ })).toHaveAttribute(
      'href',
      'https://github.com/settings/personal-access-tokens/new',
    );
    expect(screen.queryByRole('link', { name: /Create classic token/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Fine-grained personal access token'), {
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
      if (url === '/api/external-agents/paperclip/discover' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { companyId?: string };
        return response({
          health: { status: 'ok', version: '1.2.3', deploymentMode: 'local' },
          companies: [{
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Acme',
            status: 'active',
          }],
          projects: body.companyId ? [{
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Mission Control',
            status: 'active',
          }] : [],
          agents: body.companyId ? [{
            id: '33333333-3333-4333-8333-333333333333',
            name: 'Engineer',
            title: 'Software Engineer',
            role: 'engineer',
            status: 'idle',
            adapterType: 'claude-local',
          }] : [],
        });
      }
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
    fireEvent.change(screen.getByLabelText('Access token'), {
      target: { value: 'paperclip-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(await screen.findByText('Connected · Paperclip 1.2.3')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Default project'));
    fireEvent.click(screen.getByRole('option', { name: 'Mission Control' }));
    fireEvent.change(screen.getByLabelText('Always instructions'), {
      target: { value: 'Post concise progress updates.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));

    await waitFor(() => expect(requestBody).not.toBeNull());
    expect(requestBody).toMatchObject({
      type: 'paperclip',
      endpoint: 'http://localhost:3100',
      authType: 'bearer',
      credential: 'paperclip-secret',
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
    expect(screen.getByLabelText('Fine-grained personal access token')).toHaveAttribute(
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
