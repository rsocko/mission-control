import { NextResponse } from 'next/server';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * POST /api/goals/promote — Convert a goal into a full project with phases
 * 
 * Body: {
 *   taskId: string,               // The goal task being promoted
 *   projectName: string,          // Name for the new project
 *   projectDescription?: string,  // Description
 *   category?: string,            // Project category
 *   color?: string,               // Project color
 *   phases: Array<{
 *     name: string,
 *     description?: string,
 *     tasks: Array<{
 *       title: string,
 *       description?: string,
 *     }>
 *   }>
 * }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { taskId, projectName, projectDescription, category, color, phases } = body;

    if (!taskId || !projectName) {
      return NextResponse.json(
        { error: 'taskId and projectName are required' },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const projectId = `proj-${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

    const persistence = await getAIWorkflowPersistence();
    const outcome = await persistence.goalsBoard.promoteGoal({
      taskId,
      projectId,
      projectName,
      projectDescription: projectDescription || null,
      category: category || null,
      color: color || '#3b82f6',
      phases: Array.isArray(phases)
        ? phases.map((phase: { name: string; description?: string; tasks?: Array<{ title: string; description?: string }> }) => ({
            name: phase.name,
            description: phase.description || null,
            tasks: Array.isArray(phase.tasks)
              ? phase.tasks.map((task) => ({ title: task.title, description: task.description || null }))
              : [],
          }))
        : [],
      now,
    });

    if (outcome.kind === 'not-found') {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({
      projectId: outcome.projectId,
      projectName,
      phasesCreated: phases?.length || 0,
      tasksCreated: outcome.tasksCreated.length,
    }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'Goal promotion failed');
    return ApiErrors.internal('Failed to promote goal', error);
  }
}
