import { describe, expect, it, vi } from 'vitest';

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomUUID: () => 'identity-test-uuid' };
});
import {
  issueEvidenceFromGraphQL,
  issueEvidenceFromRest,
  normalizeGitHubOrigin,
  repositoryEvidenceFromGraphQL,
  repositoryEvidenceFromRest,
} from '@/lib/connectors/github-issues/identity';
import {
  mapGraphQLIssueToTask,
  mapRestIssueToTask,
} from '@/lib/connectors/github-issues/issue-transformer';

describe('GitHub identity host normalization', () => {
  it.each([
    ['https://api.github.com', 'github.com'],
    ['https://github.com', 'github.com'],
    ['https://API.GITHUB.COM.', 'github.com'],
    ['https://github.example.com/api/v3', 'github.example.com'],
    ['https://github.example.com:8443/api/v3', 'github.example.com:8443'],
    ['https://münich.example/api/v3', 'xn--mnich-kva.example'],
    ['http://localhost:3000/api/v3', 'localhost:3000'],
  ])('normalizes %s to %s', (origin, hostKey) => {
    expect(normalizeGitHubOrigin(origin).hostKey).toBe(hostKey);
  });

  it.each([
    'http://github.example.com/api/v3',
    'https://user:secret@github.example.com/api/v3',
    'https://github.example.com/untrusted',
    'https://github.example.com/api/v3?token=secret',
    'not a URL',
  ])('rejects untrusted origin %s', (origin) => {
    expect(() => normalizeGitHubOrigin(origin)).toThrow();
  });

  it('keeps coincident node IDs isolated by Enterprise host', () => {
    const github = normalizeGitHubOrigin('https://api.github.com');
    const enterprise = normalizeGitHubOrigin('https://github.example.com/api/v3');
    expect(github.hostKey).not.toBe(enterprise.hostKey);
  });
});

describe('GitHub REST and GraphQL identity evidence', () => {
  const origin = normalizeGitHubOrigin();
  const observedAt = '2026-08-08T12:00:00.000Z';
  const restRepository = {
    node_id: 'R_repo',
    full_name: 'Owner/Repo',
    url: 'https://api.github.com/repos/Owner/Repo',
    html_url: 'https://github.com/Owner/Repo',
  };
  const graphqlRepository = {
    id: 'R_repo',
    nameWithOwner: 'Owner/Repo',
    url: 'https://github.com/Owner/Repo',
  };

  it('produces equivalent host-scoped repository and issue identities', () => {
    const restRepoEvidence = repositoryEvidenceFromRest(restRepository, origin, observedAt)!;
    const graphqlRepoEvidence = repositoryEvidenceFromGraphQL(graphqlRepository, origin, observedAt);
    const restIssue = {
      node_id: 'I_issue',
      number: 42,
      title: 'Issue',
      body: null,
      state: 'open',
      created_at: observedAt,
      updated_at: observedAt,
      closed_at: null,
      url: 'https://api.github.com/repos/Owner/Repo/issues/42',
      html_url: 'https://github.com/Owner/Repo/issues/42',
      labels: [],
    };
    const restEvidence = issueEvidenceFromRest(restIssue, restRepoEvidence, origin, observedAt)!;
    const graphqlEvidence = issueEvidenceFromGraphQL(
      'I_issue',
      42,
      restIssue.html_url,
      graphqlRepoEvidence,
      origin,
      observedAt,
    );

    expect(restRepoEvidence.identity).toEqual(graphqlRepoEvidence.identity);
    expect(restEvidence.entity.identity).toEqual(graphqlEvidence.entity.identity);
    expect(restEvidence.entity.locator).toMatchObject({
      owner: 'Owner',
      repository: 'Repo',
      issueNumber: 42,
    });
    expect(graphqlEvidence.entity.locator).toMatchObject({
      owner: 'Owner',
      repository: 'Repo',
      issueNumber: 42,
    });
  });

  it('retains REST node_id in task metadata without changing sourceId', () => {
    const repository = repositoryEvidenceFromRest(restRepository, origin, observedAt)!;
    const issue = {
      node_id: 'I_issue',
      number: 42,
      title: 'Issue',
      body: null,
      state: 'open',
      created_at: observedAt,
      updated_at: observedAt,
      closed_at: null,
      html_url: 'https://github.com/Owner/Repo/issues/42',
      labels: [],
    };
    const evidence = issueEvidenceFromRest(issue, repository, origin, observedAt);
    const task = mapRestIssueToTask(issue, 'Owner/Repo', 'connector-1', evidence);
    expect(task.sourceId).toBe('Owner/Repo:42');
    expect(task.metadata.nodeId).toBe('I_issue');
    expect(task.externalIdentity?.entity.identity.stableId).toBe('I_issue');
  });

  it('keeps REST tasks legacy-only when node_id is absent', () => {
    const task = mapRestIssueToTask({
      number: 42,
      title: 'Legacy',
      body: null,
      state: 'open',
      created_at: observedAt,
      updated_at: observedAt,
      closed_at: null,
      html_url: 'https://github.com/Owner/Repo/issues/42',
      labels: [],
    }, 'Owner/Repo', 'connector-1');
    expect(task.sourceId).toBe('Owner/Repo:42');
    expect(task.metadata.nodeId).toBeUndefined();
    expect(task.externalIdentity).toBeUndefined();
  });

  it('keeps GraphQL source identity legacy-compatible', () => {
    const repository = repositoryEvidenceFromGraphQL(graphqlRepository, origin, observedAt);
    const evidence = issueEvidenceFromGraphQL(
      'I_issue',
      42,
      'https://github.com/Owner/Repo/issues/42',
      repository,
      origin,
      observedAt,
    );
    const task = mapGraphQLIssueToTask({
      id: 'I_issue',
      number: 42,
      title: 'Issue',
      body: '',
      state: 'OPEN',
      stateReason: null,
      createdAt: observedAt,
      updatedAt: observedAt,
      closedAt: null,
      url: 'https://github.com/Owner/Repo/issues/42',
    }, 'Owner/Repo', 'connector-1', evidence);
    expect(task.sourceId).toBe('Owner/Repo:42');
    expect(task.metadata.nodeId).toBe('I_issue');
  });
});
