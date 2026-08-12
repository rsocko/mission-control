import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import { tags, taskTags, tasks, connectorConfigs } from '@/db/schema';
import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler } from '@/lib/sync';
import logger, { dbLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { isDemoMode } from '@/lib/mode';
import { getConnectorCapabilities, isConnectorEnabled } from '@/lib/connectors/capabilities';
import { resolveTaskFieldPolicy } from '@/lib/tasks/field-policy';
import type { ConnectorCapabilities } from '@/types';
import { evaluateRulesForTasks } from '@/lib/rules';
import { executeFencedGitHubTaskMutation } from '@/lib/external-identities';

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const requestedTags: string[] = Array.isArray(body.tags)
      ? body.tags.map((tag: unknown) => typeof tag === 'string' ? tag.trim().slice(0, MAX_TAG_NAME_LENGTH) : '').filter((tag: string): tag is string => Boolean(tag))
      : [];

    if (!requestedTags.length) {
      return NextResponse.json({ error: 'tags is required' }, { status: 400 });
    }

    if (requestedTags.length > MAX_TAGS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many tags: maximum ${MAX_TAGS_PER_REQUEST} per request` },
        { status: 400 }
      );
    }

    // Look up the task and its connector capabilities in one pass
    const [task] = await db.select({
      connectorInstanceId: tasks.connectorInstanceId,
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
    }).from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task) return ApiErrors.notFound('Task');

    let tagCreationMode: 'freeform' | 'predefined' = 'freeform';
    let connectorCaps: Record<string, unknown> = {};
    if (task?.connectorInstanceId) {
      const [connectorRow] = await db.select({ capabilities: connectorConfigs.capabilities })
        .from(connectorConfigs).where(eq(connectorConfigs.id, task.connectorInstanceId)).limit(1);
      if (connectorRow) {
        connectorCaps = (typeof connectorRow.capabilities === 'string'
          ? JSON.parse(connectorRow.capabilities) : connectorRow.capabilities) as Record<string, unknown>;
        tagCreationMode = (connectorCaps.tagCreationMode as 'freeform' | 'predefined') || 'freeform';
      }
    }
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

    const uniqueTagNames = [...new Set(requestedTags)];
    const slugs = uniqueTagNames.map(toSlug).filter(Boolean);
    const existingTags = slugs.length
      ? await db.select().from(tags).where(inArray(tags.slug, slugs))
      : [];

    const existingTagsBySlug = new Map(existingTags.map(tag => [tag.slug, tag]));

    const tagIds: string[] = [];
    const rejectedTags: string[] = [];
    const now = new Date().toISOString();

    // Create new tags and link them to the task in a single transaction
    let newTagIds: string[] = [];
    const newTagValues: { id: string; name: string; slug: string; type: string; source: string; color: string; confirmed: boolean; createdAt: string }[] = [];

    for (const tagName of uniqueTagNames) {
      const slug = toSlug(tagName);
      if (!slug) continue;

      const existing = existingTagsBySlug.get(slug);
      if (existing) {
        tagIds.push(existing.id);
        continue;
      }

      if (tagCreationMode === 'predefined') {
        rejectedTags.push(tagName);
        continue;
      }

      const tagId = `tag-${slug}-${randomUUID().slice(0, 8)}`;
      newTagValues.push({
        id: tagId,
        name: tagName,
        slug,
        type: 'ai-inferred',
        source: 'ai',
        color: '#64748b',
        confirmed: false,
        createdAt: now,
      });
      tagIds.push(tagId);
    }

    if (rejectedTags.length && !tagIds.length) {
      return NextResponse.json(
        { error: `Tags must be predefined for this source. Unknown: ${rejectedTags.join(', ')}` },
        { status: 422 }
      );
    }

    try {
      runTransaction((tx) => {
        if (newTagValues.length) {
          tx.insert(tags).values(newTagValues).run();
        }

        const existingTaskTags = tx.select().from(taskTags).where(eq(taskTags.taskId, id)).all();
        const existingTagIds = new Set(existingTaskTags.map(entry => entry.tagId));
        newTagIds = tagIds.filter(tagId => !existingTagIds.has(tagId));

        if (newTagIds.length) {
          tx.insert(taskTags).values(newTagIds.map(tagId => ({ taskId: id, tagId }))).run();
        }
      });
    } catch (err) {
      dbLogger.error({ err, taskId: id, tagCount: uniqueTagNames.length, op: 'addTaskTags' },
        'Transaction rolled back: tag creation/linking failed');
      throw err;
    }

    // ─── TAG WRITE-BACK ─────────────────────────────────────────────────
    // If the task's connector supports tagWriteBack, push new tags to source.
    // Wrapped in its own try/catch so write-back failures never mask a
    // successful DB commit — the client must see the 200 with addedTagIds.
    try {
      if (
        tagPolicy.mutation === 'write-through'
        && newTagIds.length
        && task.connectorInstanceId
        && connectorCaps.tagWriteBack
      ) {
          // Fire-and-forget write-back
          (async () => {
            try {
              let connector = connectorRegistry.getConnector(task.connectorInstanceId!) ?? null;
              if (!connector) connector = await syncScheduler.initializeConnectorFromDb(task.connectorInstanceId!);
              if (!connector?.addTagToTask) return;

              // Resolve tag names for the newly added IDs and batch-write
              const addedTags = await db.select({ name: tags.name }).from(tags).where(inArray(tags.id, newTagIds));
              const tagNames = addedTags.map(t => t.name);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if ('addTagsToTask' in connector && typeof (connector as any).addTagsToTask === 'function') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (connector as any).addTagsToTask(task.sourceId, tagNames);
              } else {
                for (const name of tagNames) {
                await executeFencedGitHubTaskMutation({
                  connectorInstanceId: task.connectorInstanceId!,
                  taskId: id,
                  operation: 'label',
                  connector,
                  write: () => connector.addTagToTask!(task.sourceId, name),
                });
              }
              }
            } catch (err) {
              logger.error({ err, taskId: id }, 'Tag write-back failed');
            }
          })();
      }
    } catch (writeBackErr) {
      logger.error({ err: writeBackErr, taskId: id }, 'Tag write-back setup failed (tags still saved locally)');
    }

    try {
      await evaluateRulesForTasks([id]);
    } catch (error) {
      logger.error({ err: error, taskId: id }, 'Project auto-include evaluation failed after tag update');
    }

    return NextResponse.json({ success: true, addedTagIds: newTagIds, rejectedTags });
  } catch (error) {
    return ApiErrors.internal('Failed to add task tags', error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const tagId = typeof body.tagId === 'string' ? body.tagId : '';

    if (!tagId) {
      return NextResponse.json({ error: 'tagId is required' }, { status: 400 });
    }

    const [task] = await db.select({
      sourceId: tasks.sourceId,
      connectorType: tasks.connectorType,
      connectorInstanceId: tasks.connectorInstanceId,
    }).from(tasks).where(eq(tasks.id, id)).limit(1);
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

    await db.delete(taskTags).where(and(eq(taskTags.taskId, id), eq(taskTags.tagId, tagId)));

    // ─── TAG WRITE-BACK (REMOVAL) ───────────────────────────────────────
    // Wrapped so write-back failures never mask the successful DB delete.
    try {
      if (tagPolicy.mutation === 'write-through' && task.connectorInstanceId) {
        const [connectorRow] = await db.select({ capabilities: connectorConfigs.capabilities })
          .from(connectorConfigs).where(eq(connectorConfigs.id, task.connectorInstanceId)).limit(1);
        const caps = connectorRow
          ? (typeof connectorRow.capabilities === 'string' ? JSON.parse(connectorRow.capabilities) : connectorRow.capabilities) as Record<string, unknown>
          : {};

        if (caps.tagWriteBack) {
          // Fire-and-forget write-back
          (async () => {
            try {
              let connector = connectorRegistry.getConnector(task.connectorInstanceId!) ?? null;
              if (!connector) connector = await syncScheduler.initializeConnectorFromDb(task.connectorInstanceId!);
              if (!connector?.removeTagFromTask) return;

              // Resolve tag name
              const [tagRow] = await db.select({ name: tags.name }).from(tags).where(eq(tags.id, tagId)).limit(1);
              if (tagRow) {
                await executeFencedGitHubTaskMutation({
                  connectorInstanceId: task.connectorInstanceId!,
                  taskId: id,
                  operation: 'label',
                  connector,
                  write: () => connector.removeTagFromTask!(task.sourceId, tagRow.name),
                });
              }
            } catch (err) {
              logger.error({ err, taskId: id }, 'Tag removal write-back failed');
            }
          })();
        }
      }
    } catch (writeBackErr) {
      logger.error({ err: writeBackErr, taskId: id }, 'Tag removal write-back setup failed (tag still removed locally)');
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to remove task tag', error);
  }
}
