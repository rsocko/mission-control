import { createHash } from 'crypto';

export interface ConnectorTaskEligibilityRow {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  connectorType?: string;
  isChecklistItem: boolean;
  metadata: unknown;
}

export interface GitHubNativeTaskPopulation {
  count: number;
  digest: string;
  members: GitHubNativeTaskPopulationMember[];
  memberBySourceId: Map<string, GitHubNativeTaskPopulationMember>;
  memberByTaskId: Map<string, GitHubNativeTaskPopulationMember>;
}

export interface GitHubNativeTaskPopulationMember {
  localTaskId: string;
  sourceId: string;
  sourceIdDigest: string;
  issueNumber: number;
  memberDigest: string;
}

interface GitHubTaskMetadata {
  issueNumber?: unknown;
  isDraft?: unknown;
  isProjectDraft?: unknown;
}

function readMetadata(metadata: unknown): GitHubTaskMetadata {
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as GitHubTaskMetadata : {};
    } catch {
      return {};
    }
  }
  return metadata && typeof metadata === 'object' ? metadata as GitHubTaskMetadata : {};
}

export function parseNativeGitHubTaskSourceId(sourceId: string): {
  repository: string;
  issueNumber: number;
} | null {
  const match = /^([^/:]+\/[^/:]+):(\d+)$/.exec(sourceId);
  if (!match) return null;
  const issueNumber = Number(match[2]);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
  return {
    repository: match[1].toLowerCase(),
    issueNumber,
  };
}

export function isConnectorNativeTask(
  task: Omit<ConnectorTaskEligibilityRow, 'id'>,
  connectorType: string,
  expectedConnectorInstanceId?: string,
): boolean {
  if (
    task.isChecklistItem
    || (expectedConnectorInstanceId && task.connectorInstanceId !== expectedConnectorInstanceId)
  ) {
    return false;
  }
  if (connectorType !== 'github-issues') return true;
  if (task.connectorType && task.connectorType !== 'github-issues') return false;

  const source = parseNativeGitHubTaskSourceId(task.sourceId);
  if (!source) return false;
  const metadata = readMetadata(task.metadata);
  return Number.isSafeInteger(metadata.issueNumber)
    && metadata.issueNumber === source.issueNumber
    && metadata.isDraft !== true
    && metadata.isProjectDraft !== true;
}

export function canonicalizeGitHubSourceId(
  sourceId: string,
  repositoryAliases: ReadonlyMap<string, string>,
): string {
  const parsed = parseNativeGitHubTaskSourceId(sourceId);
  if (!parsed) return sourceId.toLowerCase();
  const canonicalRepository = (
    repositoryAliases.get(parsed.repository)
    ?? repositoryAliases.get(parsed.repository.toLowerCase())
    ?? parsed.repository
  ).toLowerCase();
  return `${canonicalRepository}:${parsed.issueNumber}`;
}

export function buildGitHubNativeTaskPopulation(
  tasks: readonly ConnectorTaskEligibilityRow[],
  connectorInstanceId: string,
  repositoryAliases: ReadonlyMap<string, string>,
): GitHubNativeTaskPopulation {
  const members = tasks
    .filter((task) => isConnectorNativeTask(task, 'github-issues', connectorInstanceId))
    .map((task) => {
      const sourceId = canonicalizeGitHubSourceId(task.sourceId, repositoryAliases);
      const issueNumber = parseNativeGitHubTaskSourceId(sourceId)?.issueNumber;
      if (!issueNumber) {
        throw new Error(`Eligible GitHub task ${task.id} has an invalid canonical source ID`);
      }
      const member = `${task.id}\0${sourceId}\0${issueNumber}`;
      return {
        localTaskId: task.id,
        sourceId,
        sourceIdDigest: createHash('sha256').update(sourceId).digest('hex'),
        issueNumber,
        memberDigest: createHash('sha256').update(member).digest('hex'),
      };
    })
    .sort((left, right) => left.memberDigest.localeCompare(right.memberDigest));
  return {
    count: members.length,
    digest: digestGitHubTaskPopulationMembers(
      members.map((entry) => entry.memberDigest),
    ),
    members,
    memberBySourceId: new Map(members.map((entry) => [entry.sourceId, entry])),
    memberByTaskId: new Map(members.map((entry) => [entry.localTaskId, entry])),
  };
}

export function digestGitHubTaskPopulationMembers(members: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...members].sort()))
    .digest('hex');
}
