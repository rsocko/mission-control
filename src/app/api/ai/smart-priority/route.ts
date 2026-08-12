import { computeSmartPriority } from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { resolveTaskEditPoliciesByIds } from '@/lib/tasks/edit-policy';

export async function GET() {
  try {
    const result = await computeSmartPriority();
    const policies = await resolveTaskEditPoliciesByIds(result.rankings.map((ranking) => ranking.taskId));
    return Response.json({
      ...result,
      rankings: result.rankings.map((ranking) => ({
        ...ranking,
        editPolicy: policies.get(ranking.taskId),
      })),
    });
  } catch (error) {
    aiLogger.error({ err: error }, 'Smart priority request failed');
    return ApiErrors.internal('Failed', error);
  }
}
