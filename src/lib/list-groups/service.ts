import 'server-only';

import type {
  ListOrganizationGroup,
  ListOrganizationGroupUpdate,
} from '@/db/persistence/project-organization';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

async function repository() {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.projectAutomation.listOrganization;
}

export async function getListOrganizationSnapshot() {
  return (await repository()).getSnapshot();
}

export async function createListGroup(group: ListOrganizationGroup) {
  await (await repository()).createGroup(group);
}

export async function updateListGroup(
  groupId: string,
  updates: ListOrganizationGroupUpdate,
) {
  await (await repository()).updateGroup(groupId, updates);
}

export async function deleteListGroup(groupId: string) {
  await (await repository()).deleteGroup(groupId);
}

export async function reorderListGroups(orderedIds: readonly string[]) {
  await (await repository()).reorderGroups(orderedIds);
}
