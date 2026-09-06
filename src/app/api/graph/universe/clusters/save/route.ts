import { randomUUID } from 'crypto';
import { z } from 'zod';
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
import {
  createHubProject,
} from '@/lib/projects/organization-service';
import { POST as addTaskTags } from '@/app/api/tasks/[id]/tags/route';
import { getGraphReportingPersistence } from '@/lib/graph/universe-service';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { buildTaskFilterSpec } from '@/lib/tasks/core/filter-spec';
import { normalizedCsv } from '@/app/api/tasks/query-input';
import { getLocalDaysFromNow, getLocalToday } from '@/lib/utils/date';
import { NEXT_7_DAYS } from '@/lib/tasks/due-window';
import {
  publishSemanticEntityDelete,
  publishSemanticEntityUpsert,
} from '@/lib/semantic-index/publication-service';

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
    const graphReporting = await getGraphReportingPersistence();
    let createdProject: { id: string; creationToken: string } | null = null;
    const rollbackCreatedProject = async (projectId: string, creationToken: string) => {
      const rollback = await graphReporting.clusterSave.deleteProjectIfCreationToken({
        projectId,
        creationToken,
      });
      if (!rollback.deleted) return false;
      await Promise.all([
        publishSemanticEntityDelete('project', projectId),
        ...rollback.affectedTaskIds.map((taskId) => publishSemanticEntityUpsert('task', taskId)),
      ]);
      return true;
    };
    const result = await saveUniverseCluster(input, {
      authorizeTaskIds: async (taskIds) => {
        const today = getLocalToday();
        const spec = buildTaskFilterSpec(new URLSearchParams(), {
          readCsv: normalizedCsv,
          clock: {
            today,
            weekFromNow: getLocalDaysFromNow(NEXT_7_DAYS),
            recentCutoff: getLocalDaysFromNow(-7),
          },
        });
        const { filterInputs } = await getTaskCorePersistence();
        return graphReporting.universe.listEligibleTaskIds({
          spec,
          filterInputs: {
            myDayTaskIds: await filterInputs.listMyDayTaskIds(spec.myDayDate),
            assignedGitHubUsernames: await filterInputs.listAssignedGitHubUsernames(),
            inboxListEntries: await filterInputs.listInboxListEntries(),
          },
          taskIds,
        });
      },
      createProject: async (name) => {
        const projectId = `proj-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const creationToken = randomUUID();
        if (await graphReporting.clusterSave.findProject(projectId)) {
          throw new UniverseClusterSaveError(
            'A project with this name already exists',
            'DESTINATION_CONFLICT',
            409,
          );
        }
        try {
          const created = await createHubProject({
            name,
            description: `Reviewed from transient Universe cluster ${input.clusterId}.`,
            metadata: {
              source: 'universe-cluster-review',
              projectionFingerprint: input.projectionFingerprint,
              universeClusterCreationToken: creationToken,
            },
          });
          createdProject = { id: created.id, creationToken };
          return created.id;
        } catch (error) {
          let rolledBack = false;
          try {
            rolledBack = await rollbackCreatedProject(projectId, creationToken);
          } catch {
            throw new UniverseClusterSaveError(
              'Project creation failed and the incomplete project could not be removed',
              'PROJECT_CREATION_ROLLBACK_FAILED',
              500,
            );
          }
          if (rolledBack) {
            throw error;
          }
          if (await graphReporting.clusterSave.findProject(projectId)) {
            throw new UniverseClusterSaveError(
              'A project with this name already exists',
              'DESTINATION_CONFLICT',
              409,
            );
          }
          throw error;
        }
      },
      assignProjectTasks: async (projectId, taskIds) => {
        const hierarchy = await getProjectHierarchySnapshot(projectId);
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
        if (
          createdProject?.id !== projectId
          || !await rollbackCreatedProject(projectId, createdProject.creationToken)
        ) {
          throw new Error('The created project is no longer owned by this cluster save request');
        }
      },
      createTag: async (name) => {
        const tagSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const existing = await graphReporting.clusterSave.findTagBySlug(tagSlug);
        if (existing) return existing.id;
        const created = await graphReporting.clusterSave.createTag({
          id: `tag-${tagSlug}`,
          name,
          slug: tagSlug,
          color: UNIVERSE_DIMENSION_COLORS.tags,
          createdAt: new Date().toISOString(),
        });
        if (!created.created) return created.id;
        try {
          await publishSemanticEntityUpsert('tag', created.id);
        } catch (error) {
          if (!await graphReporting.clusterSave.deleteTagIfUnused(created.id)) {
            throw new UniverseClusterSaveError(
              'Tag creation failed and the incomplete tag could not be removed',
              'TAG_CREATION_ROLLBACK_FAILED',
              500,
            );
          }
          throw error;
        }
        return created.id;
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
        await graphReporting.clusterSave.recordTagAudit({
          tagId,
          taskIds,
          clusterId: saveInput.clusterId,
          projectionFingerprint: saveInput.projectionFingerprint,
          now: new Date().toISOString(),
        });
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
