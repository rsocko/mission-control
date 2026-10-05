import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCopilotCloudTransport,
  getCopilotCloudTask,
  mapGitHubAgentTaskState,
} from '@/lib/external-agents/copilot-cloud';
import type { ExternalAgent } from '@/lib/external-agents/registry';
import type { TransportDispatch } from '@/lib/external-agents/transports';

const credentialReference = 'copilot-cloud-test';

function agent(): ExternalAgent {
  const now = new Date().toISOString();
  return {
    id: 'copilot-cloud',
    name: 'GitHub Copilot cloud agent',
    type: 'copilot-cloud',
    transport: 'push',
    executionLocality: 'github-hosted',
    description: null,
    endpoint: 'https://api.github.com/',
    authType: 'github-user',
    authCredentialRef: credentialReference,
    providerConfig: {},
    capabilities: {
      canAnalyzeCode: true,
      canWriteCode: true,
      canRunCommands: true,
      canPush: true,
      canCreatePullRequest: true,
    },
    inputFormat: 'mc-tasks',
    outputFormat: 'mc-tasks',
    inboundWebhookId: null,
    dataPolicy: {
      allowedClassifications: ['standard'],
      fieldAllowlist: [],
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function response(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers });
}

function dispatch(): TransportDispatch {
  return {
    dispatchId: 'dispatch-123',
    attempt: 1,
    scope: {
      taskIds: ['task-1'],
      repository: 'octo/example',
      defaultBranch: 'main',
      baseRef: 'main',
      model: 'gpt-5.4',
      createPullRequest: true,
    },
    payload: {
      instruction: 'Fix the failing parser',
      alwaysInstructions: 'Run focused tests before handoff.',
      repository: {
        fullName: 'octo/example',
        defaultBranch: 'main',
      },
      execution: {
        locality: 'github-hosted',
        baseRef: 'main',
        model: 'gpt-5.4',
        createPullRequest: true,
      },
      dispatchId: 'dispatch-123',
      dataClassification: 'standard',
      allowedActions: ['write_code', 'create_pull_request'],
      tasks: [{
        id: 'task-1',
        title: 'Fix the parser',
        sourceIssue: {
          type: 'github-issue',
          repository: 'octo/example',
          issueNumber: 42,
          url: 'https://github.com/octo/example/issues/42',
        },
      }],
    },
  };
}

afterEach(() => {
  delete process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON;
});

describe('GitHub Copilot cloud agent adapter', () => {
  it.each([
    ['queued', 'queued'],
    ['in_progress', 'in_progress'],
    ['idle', 'in_progress'],
    ['waiting_for_user', 'waiting_for_user'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['timed_out', 'timed_out'],
    ['cancelled', 'cancelled'],
  ] as const)('maps provider state %s to %s', (provider, canonical) => {
    expect(mapGitHubAgentTaskState(provider)).toBe(canonical);
  });

  it('deduplicates submission by finding the durable dispatch marker', async () => {
    process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
      [credentialReference]: 'user-token',
    });
    let storedPrompt: string | undefined;
    let storedBody: Record<string, unknown> | undefined;
    let created = false;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/user')) return response({ login: 'octocat' });
      if (url.endsWith('/repos/octo/example')) {
        return response({ full_name: 'octo/example' });
      }
      if (url.includes('/git/ref/heads/main')) return response({ ref: 'refs/heads/main' });
      if (url.endsWith('/graphql')) {
        return response({
          data: {
            repository: {
              suggestedActors: { nodes: [{ login: 'copilot-swe-agent' }] },
            },
          },
        });
      }
      if (url.includes('/tasks?')) {
        return response({ tasks: created ? [{ id: 'task-1', state: 'queued' }] : [] });
      }
      if (url.endsWith('/tasks/task-1')) {
        return response({
          id: 'task-1',
          state: 'queued',
          sessions: [{ prompt: storedPrompt }],
        });
      }
      if (url.endsWith('/tasks') && init?.method === 'POST') {
        storedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        storedPrompt = String(storedBody.prompt);
        created = true;
        return response({ id: 'task-1', state: 'queued' }, 201);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    const transport = createCopilotCloudTransport(fetcher as typeof fetch);

    const first = await transport.dispatch(agent(), dispatch());
    const duplicate = await transport.dispatch(agent(), dispatch());

    expect(first).toMatchObject({ providerTaskId: 'task-1', status: 'queued' });
    expect(duplicate).toMatchObject({ providerTaskId: 'task-1', status: 'queued' });
    expect(fetcher.mock.calls.filter(([input, init]) =>
      String(input).endsWith('/tasks') && init?.method === 'POST')).toHaveLength(1);
    expect(storedPrompt).toContain('Mission Control dispatch dispatch-123');
    expect(storedPrompt).toContain('"fullName":"octo/example"');
    expect(storedPrompt).toContain('"alwaysInstructions":"Run focused tests before handoff."');
    expect(storedPrompt).toContain('"sourceIssue":{"issueNumber":42');
    expect(storedPrompt).not.toContain('user-token');
    expect(storedBody).toMatchObject({
      base_ref: 'main',
      model: 'gpt-5.4',
      create_pull_request: true,
    });
  });

  it('returns actionable credential and Agent tasks permission failures', async () => {
    process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
      [credentialReference]: 'expired-token',
    });

    const invalidCredential = createCopilotCloudTransport(
      vi.fn(async () => response({ message: 'Bad credentials' }, 401)) as typeof fetch,
    );
    await expect(invalidCredential.dispatch(agent(), dispatch())).rejects.toMatchObject({
      code: 'CREDENTIAL_INVALID',
      status: 401,
    });

    const missingCredentialAgent = agent();
    missingCredentialAgent.authCredentialRef = 'missing-reference';
    await expect(
      createCopilotCloudTransport(vi.fn() as typeof fetch)
        .dispatch(missingCredentialAgent, dispatch()),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_UNAVAILABLE',
      status: 503,
    });
  });

  it('surfaces GitHub rate limits with retry guidance', async () => {
    process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
      [credentialReference]: 'user-token',
    });
    const transport = createCopilotCloudTransport(
      vi.fn(async () => response(
        { message: 'API rate limit exceeded' },
        403,
        { 'x-ratelimit-remaining': '0', 'retry-after': '12' },
      )) as typeof fetch,
    );

    await expect(transport.dispatch(agent(), dispatch())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: expect.stringContaining('Retry after 12 seconds'),
    });
  });

  it('associates the provider pull request only with the confirmed repository', async () => {
    process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
      [credentialReference]: 'user-token',
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/tasks/task-42')) {
        return response({
          id: 'task-42',
          name: 'Fix parser',
          state: 'completed',
          sessions: [{ model: 'gpt-5.4', base_ref: 'main', head_ref: 'copilot/fix-parser' }],
          artifacts: [
            {
              provider: 'github',
              type: 'pull',
              data: { id: 987654321, global_id: 'PR_kwDOExample' },
            },
            {
              provider: 'github',
              type: 'branch',
              data: { head_ref: 'copilot/fix-parser', base_ref: 'main' },
            },
          ],
        });
      }
      if (url.endsWith('/graphql')) {
        return response({
          data: {
            node: {
              __typename: 'PullRequest',
              number: 42,
              url: 'https://github.com/octo/example/pull/42',
              state: 'OPEN',
              isDraft: false,
              mergedAt: null,
              closedAt: null,
              headRefName: 'copilot/fix-parser',
              headRefOid: '0123456789abcdef',
              headRepository: { nameWithOwner: 'octo/example' },
              baseRefName: 'main',
              baseRepository: { nameWithOwner: 'octo/example' },
            },
          },
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as typeof fetch;

    const result = await getCopilotCloudTask(
      agent(),
      'octo/example',
      'main',
      'task-42',
      fetcher,
    );

    expect(result).toMatchObject({
      status: 'completed',
      providerTaskId: 'task-42',
      providerDetail: {
        pullRequest: {
          number: 42,
          state: 'open',
          url: 'https://github.com/octo/example/pull/42',
        },
      },
      result: {
        codeChange: {
          repository: 'octo/example',
          baseRef: 'main',
          branchRef: 'copilot/fix-parser',
          commitSha: '0123456789abcdef',
          pullRequestUrl: 'https://github.com/octo/example/pull/42',
        },
      },
    });
    expect(fetcher).not.toHaveBeenCalledWith(
      expect.stringContaining('/pulls/987654321'),
      expect.anything(),
    );
  });

  it('keeps provider state updates when pull request enrichment is unavailable', async () => {
    process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
      [credentialReference]: 'user-token',
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/tasks/task-closed')) {
        return response({
          id: 'task-closed',
          state: 'completed',
          updated_at: '2026-10-05T13:00:00Z',
          artifacts: [
            {
              provider: 'github',
              type: 'pull',
              data: { id: 987654321, global_id: 'PR_missing' },
            },
            {
              provider: 'github',
              type: 'branch',
              data: { head_ref: 'copilot/closed-session', base_ref: 'main' },
            },
          ],
        });
      }
      if (url.endsWith('/graphql')) {
        return response({
          data: { node: null },
          errors: [{ message: 'Could not resolve to a node' }],
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as typeof fetch;

    const result = await getCopilotCloudTask(
      agent(),
      'octo/example',
      'main',
      'task-closed',
      fetcher,
    );

    expect(result).toMatchObject({
      status: 'completed',
      providerState: 'completed',
      providerDetail: {
        outputWarning: 'GitHub reported a pull request output, but its details are unavailable.',
      },
      result: {
        codeChange: {
          repository: 'octo/example',
          baseRef: 'main',
          branchRef: 'copilot/closed-session',
        },
      },
    });
  });

  it('resolves a pull request by its reported branch when GitHub omits the global ID', async () => {
    process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
      [credentialReference]: 'user-token',
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/tasks/task-empty-global-id')) {
        return response({
          id: 'task-empty-global-id',
          state: 'completed',
          sessions: [{ model: 'gpt-5.4', base_ref: 'main' }],
          artifacts: [
            {
              provider: 'github',
              type: 'pull',
              data: { id: 4748906850, global_id: '' },
            },
            {
              provider: 'github',
              type: 'branch',
              data: { head_ref: 'copilot/dispatch-123', base_ref: 'main' },
            },
          ],
        });
      }
      if (url.endsWith('/graphql')) {
        const body = JSON.parse(String(init?.body)) as {
          variables?: Record<string, unknown>;
        };
        expect(body.variables).toMatchObject({
          owner: 'octo',
          name: 'example',
          headRef: 'copilot/dispatch-123',
          baseRef: 'main',
        });
        return response({
          data: {
            repository: {
              pullRequests: {
                nodes: [{
                  __typename: 'PullRequest',
                  number: 42,
                  url: 'https://github.com/octo/example/pull/42',
                  state: 'OPEN',
                  isDraft: true,
                  mergedAt: null,
                  closedAt: null,
                  headRefName: 'copilot/dispatch-123',
                  headRefOid: '0123456789abcdef',
                  headRepository: { nameWithOwner: 'octo/example' },
                  baseRefName: 'main',
                  baseRepository: { nameWithOwner: 'octo/example' },
                }],
              },
            },
          },
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as typeof fetch;

    const result = await getCopilotCloudTask(
      agent(),
      'octo/example',
      'main',
      'task-empty-global-id',
      fetcher,
    );

    expect(result).toMatchObject({
      status: 'completed',
      providerDetail: {
        pullRequest: {
          number: 42,
          state: 'draft',
          url: 'https://github.com/octo/example/pull/42',
        },
      },
      result: {
        codeChange: {
          repository: 'octo/example',
          baseRef: 'main',
          branchRef: 'copilot/dispatch-123',
          commitSha: '0123456789abcdef',
          pullRequestUrl: 'https://github.com/octo/example/pull/42',
        },
      },
    });
    expect(result.providerDetail).not.toHaveProperty('outputWarning');
  });

  it('does not warn about a placeholder pull request while the task is queued', async () => {
    process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
      [credentialReference]: 'user-token',
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/tasks/task-queued')) {
        return response({
          id: 'task-queued',
          state: 'queued',
          artifacts: [
            {
              provider: 'github',
              type: 'pull',
              data: {},
            },
          ],
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as typeof fetch;

    const result = await getCopilotCloudTask(
      agent(),
      'octo/example',
      'main',
      'task-queued',
      fetcher,
    );

    expect(result).toMatchObject({
      status: 'queued',
      providerState: 'queued',
    });
    expect(result.providerDetail).not.toHaveProperty('outputWarning');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('warns about an unresolved pull request after the task completes', async () => {
    process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
      [credentialReference]: 'user-token',
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/tasks/task-completed')) {
        return response({
          id: 'task-completed',
          state: 'completed',
          artifacts: [
            {
              provider: 'github',
              type: 'pull',
              data: {},
            },
          ],
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as typeof fetch;

    const result = await getCopilotCloudTask(
      agent(),
      'octo/example',
      'main',
      'task-completed',
      fetcher,
    );

    expect(result).toMatchObject({
      status: 'completed',
      providerState: 'completed',
      providerDetail: {
        outputWarning: 'GitHub reported a pull request output without a resolvable global ID.',
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
