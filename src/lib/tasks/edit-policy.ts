import 'server-only';

import db from '@/db';
import { tasks } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { isDemoMode } from '@/lib/mode';
import type {
  ConnectorCapabilities,
  TaskEditPolicy,
  TaskField,
  TaskFieldPolicy,
} from '@/types';
import {
  resolveTaskFieldPolicy,
  resolveTaskSourceModel,
  TASK_FIELDS,
  type TaskSourceIdentity,
} from './field-policy';

export interface TaskEditPolicyIdentity {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
}

export interface ConnectorEditPolicyContext {
  capabilities: ConnectorCapabilities | null;
  connectorEnabled: boolean;
}

export function requireTaskEditPolicy(
  policies: ReadonlyMap<string, TaskEditPolicy>,
  taskId: string,
): TaskEditPolicy {
  const policy = policies.get(taskId);
  if (!policy) {
    throw new Error(`Missing resolved edit policy for task ${taskId}`);
  }
  return policy;
}

function isLocalTask(task: TaskEditPolicyIdentity): boolean {
  return task.connectorType === 'local'
    || task.connectorType === 'mission-control'
    || task.sourceId.startsWith('local:');
}

export function resolveTaskEditPolicy(
  task: TaskSourceIdentity,
  capabilities: ConnectorCapabilities | null,
): TaskEditPolicy {
  const sourceModel = resolveTaskSourceModel(task, capabilities);
  const fields = {} as Record<TaskField, TaskFieldPolicy>;
  const editableFields: TaskField[] = [];
  const fieldReasons: Partial<Record<TaskField, string>> = {};

  for (const field of TASK_FIELDS) {
    const policy = resolveTaskFieldPolicy(task, capabilities, field);
    fields[field] = policy;
    if (policy.mutation === 'blocked') {
      if (policy.reason) fieldReasons[field] = policy.reason;
    } else {
      editableFields.push(field);
    }
  }

  const localDeleteSupported = sourceModel === 'mc-owned';
  const upstreamDeleteSupported = sourceModel === 'remote-managed'
    && task.connectorEnabled
    && capabilities?.delete === true;
  const removalMode = sourceModel === 'remote-mirror'
    ? 'local-dismiss'
    : !task.connectorEnabled && sourceModel !== 'mc-owned' && sourceModel !== 'ingested'
    ? 'blocked'
    : sourceModel === 'mc-owned'
      ? 'local-delete'
      : sourceModel === 'ingested'
        ? 'local-cancel'
        : sourceModel === 'remote-managed' && capabilities?.delete === true
          ? 'upstream-delete'
          : sourceModel === 'remote-managed' && capabilities?.close === true
            ? 'upstream-close'
            : 'blocked';
  const sourceMoveSupported = sourceModel === 'mc-owned'
    || (
      sourceModel === 'remote-managed'
      && task.connectorEnabled
      && capabilities?.write === true
      && capabilities.taskMove === true
    );

  return {
    sourceModel,
    connectorEnabled: task.connectorEnabled,
    fields,
    editableFields,
    fieldReasons,
    localDeleteSupported,
    upstreamDeleteSupported,
    removalMode,
    ...(removalMode === 'blocked'
      ? {
          removalReason: !task.connectorEnabled
            ? 'This task cannot be removed while its connector is disabled'
            : 'The upstream source does not support removing this task',
        }
      : {}),
    sourceMoveSupported,
    ...(!sourceMoveSupported
      ? {
          sourceMoveReason: !task.connectorEnabled
            ? 'This task cannot be moved within its source while the connector is disabled'
            : 'The upstream source does not support moving this task',
        }
      : {}),
    localDispositionSupported: fields.localDisposition.mutation !== 'blocked',
  };
}

export async function resolveTaskEditPolicies<T extends TaskEditPolicyIdentity>(
  taskRows: readonly T[],
  prefetchedConnectorContexts?: ReadonlyMap<string, ConnectorEditPolicyContext>,
): Promise<Map<string, TaskEditPolicy>> {
  const forceLocal = isDemoMode();
  const connectorIds = [
    ...new Set(
      taskRows
        .filter((task) => !isLocalTask(task))
        .map((task) => task.connectorInstanceId),
    ),
  ];
  const connectorContexts = new Map<string, ConnectorEditPolicyContext>(
    prefetchedConnectorContexts,
  );

  await Promise.all(connectorIds
    .filter((connectorInstanceId) => !connectorContexts.has(connectorInstanceId))
    .map(async (connectorInstanceId) => {
    const [capabilities, connectorEnabled] = await Promise.all([
      getConnectorCapabilities(connectorInstanceId),
      isConnectorEnabled(connectorInstanceId),
    ]);
    connectorContexts.set(connectorInstanceId, { capabilities, connectorEnabled });
  }));

  return new Map(taskRows.map((task) => {
    const local = isLocalTask(task);
    const context = local
      ? { capabilities: null, connectorEnabled: true }
      : connectorContexts.get(task.connectorInstanceId)
        ?? { capabilities: null, connectorEnabled: false };
    return [
      task.id,
      resolveTaskEditPolicy({
        sourceId: task.sourceId,
        connectorType: task.connectorType,
        connectorEnabled: context.connectorEnabled,
        forceLocal,
      }, context.capabilities),
    ];
  }));
}

export async function resolveTaskEditPoliciesByIds(
  taskIds: readonly string[],
): Promise<Map<string, TaskEditPolicy>> {
  const uniqueIds = [...new Set(taskIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const taskRows = await db.select({
    id: tasks.id,
    sourceId: tasks.sourceId,
    connectorType: tasks.connectorType,
    connectorInstanceId: tasks.connectorInstanceId,
  }).from(tasks).where(inArray(tasks.id, uniqueIds));

  return resolveTaskEditPolicies(taskRows);
}
