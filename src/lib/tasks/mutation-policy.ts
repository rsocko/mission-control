import 'server-only';

import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { isDemoMode } from '@/lib/mode';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { resolveTaskFieldPolicy, type FieldPolicy } from './field-policy';
import type { ConnectorCapabilities, TaskField } from '@/types';

export interface StoredTaskMutationPolicy {
  task: {
    id: string;
    sourceId: string;
    connectorType: string;
    connectorInstanceId: string;
  };
  capabilities: ConnectorCapabilities | null;
  policy: FieldPolicy;
}

export async function getStoredTaskMutationPolicy(
  taskId: string,
  field: TaskField,
): Promise<StoredTaskMutationPolicy | null> {
  const persistence = await getTaskCorePersistence();
  const task = await persistence.policyIdentities.getTaskSourceIdentity(taskId);
  if (!task) return null;

  const isLocal = task.sourceId.startsWith('local:') || task.connectorType === 'local';
  const [capabilities, connectorEnabled] = isLocal
    ? [null, true] as const
    : await Promise.all([
        getConnectorCapabilities(task.connectorInstanceId),
        isConnectorEnabled(task.connectorInstanceId),
      ]);

  return {
    task: {
      id: task.id,
      sourceId: task.sourceId,
      connectorType: task.connectorType,
      connectorInstanceId: task.connectorInstanceId,
    },
    capabilities,
    policy: resolveTaskFieldPolicy({
      sourceId: task.sourceId,
      connectorType: task.connectorType,
      connectorEnabled,
      forceLocal: isDemoMode(),
    }, capabilities, field),
  };
}

export async function getStoredRelationshipMutationPolicies(
  taskId: string,
  relationshipId: string,
): Promise<StoredTaskMutationPolicy[] | null> {
  const dependencyId = relationshipId.startsWith('dependency:')
    ? relationshipId.slice('dependency:'.length)
    : relationshipId;
  const persistence = await getTaskCorePersistence();
  const dependency = await persistence.policyIdentities.getDependencyEndpoints(dependencyId);
  if (
    !dependency
    || (dependency.taskId !== taskId && dependency.dependsOnTaskId !== taskId)
  ) {
    return null;
  }

  const taskIds = [...new Set([dependency.taskId, dependency.dependsOnTaskId])];
  const policies = await Promise.all(
    taskIds.map((id) => getStoredTaskMutationPolicy(id, 'dependencies')),
  );
  return policies.every((policy): policy is StoredTaskMutationPolicy => policy !== null)
    ? policies
    : null;
}
