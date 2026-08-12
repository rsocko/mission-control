import { autoAssignProjects } from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { resolveTaskEditPoliciesByIds } from '@/lib/tasks/edit-policy';

export async function GET() {
  try {
    const result = await autoAssignProjects();
    const policies = await resolveTaskEditPoliciesByIds(result.assignments.map((assignment) => assignment.taskId));
    return Response.json({
      ...result,
      assignments: result.assignments.map((assignment) => ({
        ...assignment,
        editPolicy: policies.get(assignment.taskId),
      })),
    });
  } catch (error) {
    aiLogger.error({ err: error }, 'Auto-assign projects request failed');
    return ApiErrors.internal('Failed', error);
  }
}

export async function POST() {
  return GET();
}
