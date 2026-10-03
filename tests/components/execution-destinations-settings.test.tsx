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
    expect(screen.queryByText('No execution destinations yet')).not.toBeInTheDocument();
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

    expect(await screen.findByText('No execution destinations yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GitHub Copilot Cloud' }));
    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: 'github_pat_test-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));

    await waitFor(() => expect(requestBody).not.toBeNull());
    expect(requestBody).toMatchObject({
      name: 'GitHub Copilot Cloud',
      type: 'copilot-cloud',
      endpoint: 'https://api.github.com',
      authType: 'github-user',
      credential: 'github_pat_test-value',
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
    expect(await screen.findByText('No execution destinations yet')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));

    await waitFor(() => expect(requestBody).not.toBeNull());
    expect(requestBody).toMatchObject({
      type: 'paperclip',
      endpoint: 'http://localhost:3100',
      authType: 'none',
      authCredentialRef: null,
      providerConfig: {
        paperclip: {
          companyId: '11111111-1111-4111-8111-111111111111',
          projectId: '22222222-2222-4222-8222-222222222222',
          assigneeAgentId: '33333333-3333-4333-8333-333333333333',
          requiredAdapterType: 'claude-local',
        },
      },
    });
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
      providerConfig: {},
      capabilities: { canAnalyzeCode: true },
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
    expect(getCount).toBeGreaterThanOrEqual(2);
  });
});
