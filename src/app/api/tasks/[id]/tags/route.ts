import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { getConnectorRegistry } from '@/lib/connectors/registry-runtime';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { isDemoMode } from '@/lib/mode';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { resolveTaskFieldPolicy } from '@/lib/tasks/field-policy';
import type { ConnectorCapabilities, ConnectorConfig } from '@/types';
import { evaluateRulesForTasks } from '@/lib/rules';
import { executeFencedGitHubTaskMutation } from '@/lib/external-identities';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

const MAX_TAGS_PER_REQUEST = 20;
const MAX_TAG_NAME_LENGTH = 100;

function withTagWriteBackPolicy(
  capabilities: ConnectorCapabilities | null,
): ConnectorCapabilities | null {
  if (!capabilities?.tagWriteBack) return capabilities;
  return {
    ...capabilities,
    taskFieldProfile: {
      ...capabilities.taskFieldProfile,
      tags: { authority: 'source', writeBack: 'direct' },
    },
  };
}

function toSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function getOrRefreshTagConnector(connectorInstanceId: string) {
  const registry = getConnectorRegistry();
  const existing = registry.getConnector(connectorInstanceId);
  if (existing) return existing;
  const repositories = await getWorkerPersistenceRepositories();
  const config = await repositories.connectors.get(connectorInstanceId);
  if (!config) return null;
  repositories.execution.support.assertConfigSupported(config);
  const resolvedConfig: ConnectorConfig = {
    ...config,
    syncMode: config.syncMode || 'poll',
    pollIntervalMinutes: config.pollIntervalMinutes ?? 5,
  };
  return registry.replaceConnector(resolvedConfig);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const requestedTags: string[] = Array.isArray(body.tags)
      ? body.tags
        .map((tag: unknown) => typeof tag === 'string'
          ? tag.trim().slice(0, MAX_TAG_NAME_LENGTH)
          : '')
        .filter((tag: string): tag is string => Boolean(tag))
      : [];

    if (!requestedTags.length) {
      return NextResponse.json({ error: 'tags is required' }, { status: 400 });
    }
    if (requestedTags.length > MAX_TAGS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many tags: maximum ${MAX_TAGS_PER_REQUEST} per request` },
        { status: 400 },
      );
    }

    const { ancillary } = await getTaskCorePersistence();
    const { task, storedCapabilities } = await ancillary.getTagMutationContext(id);
    if (!task) return ApiErrors.notFound('Task');

    const tagCreationMode =
      (storedCapabilities.tagCreationMode as 'freeform' | 'predefined') || 'freeform';
    const isLocalOnly = task.sourceId.startsWith('local:') || task.connectorType === 'local';
    const [capabilities, connectorEnabled] = isLocalOnly
      ? [null, true] as const
      : await Promise.all([
          getConnectorCapabilities(task.connectorInstanceId),
          isConnectorEnabled(task.connectorInstanceId),
        ]);
    const tagPolicy = resolveTaskFieldPolicy({
      sourceId: task.sourceId,
      connectorType: task.connectorType,
      connectorEnabled,
      forceLocal: isDemoMode(),
    }, withTagWriteBackPolicy(capabilities), 'tags');
    if (tagPolicy.mutation === 'blocked') {
      return ApiErrors.forbidden(tagPolicy.reason ?? 'Tags cannot be changed for this task source');
    }

    const candidatesBySlug = new Map<string, { id: string; name: string; slug: string }>();
    for (const name of requestedTags) {
      const slug = toSlug(name);
      if (slug && !candidatesBySlug.has(slug)) {
        candidatesBySlug.set(slug, {
          id: `tag-${slug}-${randomUUID().slice(0, 8)}`,
          name,
          slug,
        });
      }
    }
    const result = await ancillary.addTaskTags({
      taskId: id,
      candidates: [...candidatesBySlug.values()],
      tagCreationMode,
      now: new Date().toISOString(),
    });
    if (
      result.rejectedTags.length > 0
      && result.rejectedTags.length === candidatesBySlug.size
    ) {
      return NextResponse.json(
        {
          error:
            `Tags must be predefined for this source. Unknown: ${result.rejectedTags.join(', ')}`,
        },
        { status: 422 },
      );
    }

    if (
      tagPolicy.mutation === 'write-through'
      && result.addedTags.length
      && task.connectorInstanceId
    ) {
      void writeTagsToSource({
        connectorInstanceId: task.connectorInstanceId,
        taskId: id,
        sourceId: task.sourceId,
        tagNames: result.addedTags.map((tag) => tag.name),
      });
    }

    try {
      await evaluateRulesForTasks([id]);
    } catch (error) {
      logger.error({ err: error, taskId: id }, 'Project auto-include evaluation failed after tag update');
    }

    return NextResponse.json({
      success: true,
      addedTagIds: result.addedTags.map((tag) => tag.id),
      rejectedTags: result.rejectedTags,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to add task tags', error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const tagId = typeof body.tagId === 'string' ? body.tagId : '';
    if (!tagId) {
      return NextResponse.json({ error: 'tagId is required' }, { status: 400 });
    }

    const { ancillary } = await getTaskCorePersistence();
    const { task } = await ancillary.getTagMutationContext(id);
    if (!task) return ApiErrors.notFound('Task');
    const isLocalOnly = task.sourceId.startsWith('local:') || task.connectorType === 'local';
    const [capabilities, connectorEnabled] = isLocalOnly
      ? [null, true] as const
      : await Promise.all([
          getConnectorCapabilities(task.connectorInstanceId),
          isConnectorEnabled(task.connectorInstanceId),
        ]);
    const tagPolicy = resolveTaskFieldPolicy({
      sourceId: task.sourceId,
      connectorType: task.connectorType,
      connectorEnabled,
      forceLocal: isDemoMode(),
    }, withTagWriteBackPolicy(capabilities), 'tags');
    if (tagPolicy.mutation === 'blocked') {
      return ApiErrors.forbidden(tagPolicy.reason ?? 'Tags cannot be changed for this task source');
    }

    const removed = await ancillary.removeTaskTag({ taskId: id, tagId });
    if (
      tagPolicy.mutation === 'write-through'
      && task.connectorInstanceId
      && removed.tagName
    ) {
      void removeTagFromSource({
        connectorInstanceId: task.connectorInstanceId,
        taskId: id,
        sourceId: task.sourceId,
        tagName: removed.tagName,
      });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to remove task tag', error);
  }
}

async function writeTagsToSource(input: {
  connectorInstanceId: string;
  taskId: string;
  sourceId: string;
  tagNames: string[];
}): Promise<void> {
  try {
    const connector = await getOrRefreshTagConnector(input.connectorInstanceId);
    if (!connector?.addTagToTask) return;
    if (
      'addTagsToTask' in connector
      && typeof (connector as { addTagsToTask?: unknown }).addTagsToTask === 'function'
    ) {
      await (connector as { addTagsToTask(sourceId: string, tags: string[]): Promise<void> })
        .addTagsToTask(input.sourceId, input.tagNames);
      return;
    }
    for (const name of input.tagNames) {
      await executeFencedGitHubTaskMutation({
        connectorInstanceId: input.connectorInstanceId,
        taskId: input.taskId,
        operation: 'label',
        connector,
        write: () => connector.addTagToTask!(input.sourceId, name),
      });
    }
  } catch (error) {
    logger.error({ err: error, taskId: input.taskId }, 'Tag write-back failed');
  }
}

async function removeTagFromSource(input: {
  connectorInstanceId: string;
  taskId: string;
  sourceId: string;
  tagName: string;
}): Promise<void> {
  try {
    const connector = await getOrRefreshTagConnector(input.connectorInstanceId);
    if (!connector?.removeTagFromTask) return;
    await executeFencedGitHubTaskMutation({
      connectorInstanceId: input.connectorInstanceId,
      taskId: input.taskId,
      operation: 'label',
      connector,
      write: () => connector.removeTagFromTask!(input.sourceId, input.tagName),
    });
  } catch (error) {
    logger.error({ err: error, taskId: input.taskId }, 'Tag removal write-back failed');
  }
}
