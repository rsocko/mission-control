import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import db from '@/db';
import { hubProjects, tags, taskHistoryEvents, tasks } from '@/db/schema';
import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  MAX_UNIVERSE_CLUSTER_SAVE_TASKS,
  saveUniverseCluster,
  UniverseClusterSaveError,
} from '@/lib/graph/universe-cluster-save';
import { isUniverseClustersEnabled } from '@/lib/graph/universe-semantic-config';
import { UNIVERSE_DIMENSION_COLORS } from '@/lib/graph/universe-types';
import {
  applyProjectHierarchyCommand,
  getProjectHierarchySnapshot,
  ProjectHierarchyServiceError,
} from '@/lib/projects/hierarchy-service';
import { getCanonicalTaskFilterWhere } from '@/app/api/tasks/canonical-filter';
import {
  DELETE as deleteHubProject,
  POST as createHubProject,
} from '@/app/api/hub-projects/route';
import {
  DELETE as deleteHubTag,
  POST as createHubTag,
} from '@/app/api/tags/route';
import { POST as addTaskTags } from '@/app/api/tasks/[id]/tags/route';

const saveRequestSchema = z.object({
  destination: z.enum(['project', 'tag']),
  name: z.string().trim().min(1).max(100)
    .refine((name) => /[a-z0-9]/i.test(name), 'Destination name must include a letter or number'),
  taskIds: z.array(z.string().trim().min(1))
    .min(1)
    .max(MAX_UNIVERSE_CLUSTER_SAVE_TASKS)
    .refine((ids) => new Set(ids).size === ids.length, 'Task IDs must be unique'),
  clusterId: z.string().trim().min(1).max(100),
  projectionFingerprint: z.string().trim().min(1).max(100),
});

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

function domainError(response: Response, payload: Record<string, unknown>, fallback: string): Error {
  const message = typeof payload.error === 'string' ? payload.error : fallback;
  const error = new UniverseClusterSaveError(
    message,
    typeof payload.code === 'string' ? payload.code : 'DOMAIN_COMMAND_FAILED',
    response.status,
  );
  return error;
}

function internalRequest(origin: string, path: string, body: unknown): Request {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function removeIncompleteDestination(
  origin: string,
  destination: 'project' | 'tag',
  destinationId: string,
): Promise<boolean> {
  const deleteHandler = destination === 'project' ? deleteHubProject : deleteHubTag;
  await deleteHandler(new Request(
    `${origin}/api/${destination === 'project' ? 'hub-projects' : 'tags'}?id=${
      encodeURIComponent(destinationId)
    }`,
    { method: 'DELETE' },
  ));
  if (destination === 'project') {
    const [remaining] = await db.select({ id: hubProjects.id })
      .from(hubProjects)
      .where(eq(hubProjects.id, destinationId))
      .limit(1);
    return !remaining;
  }
  const [remaining] = await db.select({ id: tags.id })
    .from(tags)
    .where(eq(tags.id, destinationId))
    .limit(1);
  return !remaining;
}

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return ApiErrors.forbidden('Cluster save requires a trusted same-origin request');
  }
  if (!isUniverseClustersEnabled()) {
    return ApiErrors.forbidden('Universe cluster grouping is disabled');
  }

  try {
    const parsed = saveRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid cluster save request');
    }
    const input = parsed.data;
    const origin = new URL(request.url).origin;
    const result = await saveUniverseCluster(input, {
      authorizeTaskIds: async (taskIds) => {
        const { taskWhere } = await getCanonicalTaskFilterWhere(
          new URLSearchParams(),
        );
        const rows = await db.select({ id: tasks.id })
          .from(tasks)
          .where(and(taskWhere, inArray(tasks.id, taskIds)));
        return rows.map((row) => row.id);
      },
      createProject: async (name) => {
        const projectId = `proj-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const [existing] = await db.select({ id: hubProjects.id })
          .from(hubProjects)
          .where(eq(hubProjects.id, projectId))
          .limit(1);
        if (existing) {
          throw new UniverseClusterSaveError(
            'A project with this name already exists',
            'DESTINATION_CONFLICT',
            409,
          );
        }
        const response = await createHubProject(internalRequest(
          origin,
          '/api/hub-projects',
          {
            name,
            description: `Reviewed from transient Universe cluster ${input.clusterId}.`,
            metadata: {
              source: 'universe-cluster-review',
              projectionFingerprint: input.projectionFingerprint,
            },
          },
        ));
        const payload = await responseJson(response);
        if (!response.ok || typeof payload.id !== 'string') {
          const [created] = await db.select({ id: hubProjects.id })
            .from(hubProjects)
            .where(eq(hubProjects.id, projectId))
            .limit(1);
          if (
            created
            && !await removeIncompleteDestination(origin, 'project', projectId)
          ) {
            throw new UniverseClusterSaveError(
              'Project creation failed and the incomplete project could not be removed',
              'PROJECT_CREATION_ROLLBACK_FAILED',
              500,
            );
          }
          throw domainError(response, payload, 'Project could not be created');
        }
        return payload.id;
      },
      assignProjectTasks: async (projectId, taskIds) => {
        const hierarchy = getProjectHierarchySnapshot(projectId);
        if (!hierarchy) {
          throw new Error('The new project hierarchy is unavailable');
        }
        try {
          await applyProjectHierarchyCommand({
            projectId,
            request: {
              commandId: randomUUID(),
              expectedRevision: hierarchy.revision,
              command: { type: 'assign_tasks', taskIds },
            },
            actor: { type: 'user', id: 'universe-cluster-review' },
          });
        } catch (error) {
          if (error instanceof ProjectHierarchyServiceError) {
            throw new UniverseClusterSaveError(error.message, error.code, error.status);
          }
          throw error;
        }
      },
      rollbackProject: async (projectId) => {
        const response = await deleteHubProject(new Request(
          `${origin}/api/hub-projects?id=${encodeURIComponent(projectId)}`,
          { method: 'DELETE' },
        ));
        if (!response.ok) {
          throw domainError(
            response,
            await responseJson(response),
            'The incomplete project could not be removed',
          );
        }
      },
      createTag: async (name) => {
        const tagSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const [existing] = await db.select({ id: tags.id })
          .from(tags)
          .where(eq(tags.slug, tagSlug))
          .limit(1);
        const response = await createHubTag(internalRequest(
          origin,
          '/api/tags',
          { name, color: UNIVERSE_DIMENSION_COLORS.tags },
        ));
        const payload = await responseJson(response);
        if (!response.ok || typeof payload.id !== 'string') {
          const tagId = `tag-${tagSlug}`;
          const [created] = await db.select({ id: tags.id })
            .from(tags)
            .where(eq(tags.id, tagId))
            .limit(1);
          if (
            !existing
            && created
            && !await removeIncompleteDestination(origin, 'tag', tagId)
          ) {
            throw new UniverseClusterSaveError(
              'Tag creation failed and the incomplete tag could not be removed',
              'TAG_CREATION_ROLLBACK_FAILED',
              500,
            );
          }
          throw domainError(response, payload, 'Tag could not be created');
        }
        return payload.id;
      },
      addTagToTask: async (taskId, tagName) => {
        const response = await addTaskTags(
          internalRequest(origin, `/api/tasks/${encodeURIComponent(taskId)}/tags`, {
            tags: [tagName],
          }),
          { params: Promise.resolve({ id: taskId }) },
        );
        if (!response.ok) {
          throw domainError(
            response,
            await responseJson(response),
            `Tag could not be applied to task ${taskId}`,
          );
        }
      },
      recordTagAudit: async (saveInput, tagId, taskIds) => {
        const now = new Date().toISOString();
        await db.insert(taskHistoryEvents).values(taskIds.map((taskId) => ({
          taskId,
          eventType: 'universe_cluster_saved',
          fieldName: 'tags',
          previousValue: null,
          newValue: tagId,
          occurredAt: now,
          recordedAt: now,
          provenance: 'user',
          provenanceRef: {
            clusterId: saveInput.clusterId,
            projectionFingerprint: saveInput.projectionFingerprint,
          },
          metadata: { reviewed: true },
        })));
      },
    });
    return Response.json(result, { status: result.status === 'partial' ? 207 : 201 });
  } catch (error) {
    if (error instanceof UniverseClusterSaveError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return ApiErrors.internal('Failed to save reviewed Universe cluster', error);
  }
}
