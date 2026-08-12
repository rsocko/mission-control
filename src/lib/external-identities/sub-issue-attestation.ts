import { and, eq, like } from 'drizzle-orm';
import {
  githubIdentityComparisonRecords,
  githubIdentitySubIssuePopulationMembers,
} from '@/db/schema';
import { digestGitHubTaskPopulationMembers } from '@/lib/sync/github-native-task';
import type { ExternalIdentityTransaction } from './service';

export interface GitHubSubIssueAttestationRun {
  id: string;
  syncKind: string;
  subIssueGenerationComplete: boolean;
  subIssueExpectedChildCount: number;
  subIssueExpectedParentCount: number;
  subIssuePopulationCount: number;
  subIssuePopulationDigest: string | null;
  subIssueObservedChildCount: number;
  subIssueObservedChildDigest: string | null;
}

export function hasCompleteGitHubSubIssueAttestation(
  database: ExternalIdentityTransaction,
  run: GitHubSubIssueAttestationRun,
): boolean {
  if (
    run.syncKind !== 'full'
    || !run.subIssueGenerationComplete
    || !run.subIssuePopulationDigest
    || !run.subIssueObservedChildDigest
    || run.subIssueExpectedChildCount !== run.subIssuePopulationCount
    || run.subIssueObservedChildCount !== run.subIssuePopulationCount
    || run.subIssueObservedChildDigest !== run.subIssuePopulationDigest
  ) {
    return false;
  }
  const members = database.select({
    localTaskId: githubIdentitySubIssuePopulationMembers.localTaskId,
    memberDigest: githubIdentitySubIssuePopulationMembers.memberDigest,
    observed: githubIdentitySubIssuePopulationMembers.observed,
  }).from(githubIdentitySubIssuePopulationMembers).where(
    eq(githubIdentitySubIssuePopulationMembers.runId, run.id),
  ).all();
  if (
    members.length !== run.subIssuePopulationCount
    || members.filter((member) => member.observed).length !== run.subIssueObservedChildCount
    || digestGitHubTaskPopulationMembers(members.map((member) => member.memberDigest))
      !== run.subIssuePopulationDigest
    || digestGitHubTaskPopulationMembers(
      members.filter((member) => member.observed).map((member) => member.memberDigest),
    ) !== run.subIssueObservedChildDigest
  ) {
    return false;
  }
  const memberByTask = new Map(members.map((member) => [
    member.localTaskId,
    member.memberDigest,
  ]));
  const childRecords = database.select({
    localTaskId: githubIdentityComparisonRecords.localTaskId,
  }).from(githubIdentityComparisonRecords).where(and(
    eq(githubIdentityComparisonRecords.runId, run.id),
    eq(githubIdentityComparisonRecords.surface, 'sub_issue'),
    like(githubIdentityComparisonRecords.candidateKey, 'sub_issue:%:child'),
  )).all();
  const parentRecords = database.select({
    id: githubIdentityComparisonRecords.id,
  }).from(githubIdentityComparisonRecords).where(and(
    eq(githubIdentityComparisonRecords.runId, run.id),
    eq(githubIdentityComparisonRecords.surface, 'sub_issue'),
    like(githubIdentityComparisonRecords.candidateKey, 'sub_issue:%:parent'),
  )).all();
  const recordDigests = childRecords.flatMap((record) => {
    const memberDigest = record.localTaskId
      ? memberByTask.get(record.localTaskId)
      : undefined;
    return memberDigest ? [memberDigest] : [];
  });
  return childRecords.length === run.subIssuePopulationCount
    && new Set(childRecords.map((record) => record.localTaskId)).size
      === run.subIssuePopulationCount
    && digestGitHubTaskPopulationMembers(recordDigests) === run.subIssuePopulationDigest
    && parentRecords.length === run.subIssueExpectedParentCount;
}
