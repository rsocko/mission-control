import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { tasks, hubProjects, taskProjects, projectPhases, projectPhaseItems, taskTags, tags } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
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

    // Verify the task exists
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const projectId = `proj-${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

    // Wrap all creation in a single transaction for atomicity
    const createdTasks: string[] = [];
    runTransaction((tx) => {
      // Create the hub project
      tx.insert(hubProjects).values({
        id: projectId,
        name: projectName,
        description: projectDescription || task.description || null,
        color: color || '#3b82f6',
        icon: null,
        sourceBindings: [],
        autoIncludeRules: [],
        kanbanColumns: [],
        defaultView: 'list',
        category: category || null,
        targetDate: null,
        status: 'active',
        metadata: { promotedFrom: taskId },
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      }).run();

      // Link the original goal task to the new project
      tx.insert(taskProjects).values({
        taskId: task.id,
        projectId,
      }).run();

      // Create phases and their tasks
      if (phases && Array.isArray(phases)) {
        for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
          const phase = phases[phaseIdx];
          const phaseId = `phase-${projectId}-${phaseIdx + 1}`;

          tx.insert(projectPhases).values({
            id: phaseId,
            projectId,
            name: phase.name,
            description: phase.description || null,
            status: phaseIdx === 0 ? 'in_progress' : 'pending',
            color: null,
            estimatedDays: null,
            targetStart: null,
            targetEnd: null,
            sortOrder: phaseIdx,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          }).run();

          // Create tasks for this phase
          if (phase.tasks && Array.isArray(phase.tasks)) {
            for (let taskIdx = 0; taskIdx < phase.tasks.length; taskIdx++) {
              const phaseTask = phase.tasks[taskIdx];
              const newTaskId = `mc-goal-${projectId}-p${phaseIdx + 1}-t${taskIdx + 1}`;

              tx.insert(tasks).values({
                id: newTaskId,
                sourceId: newTaskId,
                connectorType: 'mission-control',
                connectorInstanceId: 'mc-local',
                title: phaseTask.title,
                description: phaseTask.description || null,
                status: 'todo',
                priority: 'medium',
                dueDate: null,
                createdAt: now,
                updatedAt: now,
                completedAt: null,
                parentId: null,
                depth: 0,
                isChecklistItem: false,
                sourceListId: null,
                sourceListName: null,
                assignee: null,
                metadata: {},
                syncStatus: 'synced',
                lastSyncedAt: now,
                kanbanColumn: null,
                kanbanOrder: null,
              }).run();

              // Link new task to project
              tx.insert(taskProjects).values({
                taskId: newTaskId,
                projectId,
              }).run();

              // Add task to phase
              tx.insert(projectPhaseItems).values({
                id: `ppi-${phaseId}-${taskIdx}`,
                phaseId,
                taskId: newTaskId,
                sortOrder: taskIdx,
                estimatedEffortHours: null,
                isProposed: false,
                proposalType: null,
                createdAt: now,
              }).run();

              createdTasks.push(newTaskId);
            }
          }
        }
      }

      // Update the original goal task status to indicate it was promoted
      tx.update(tasks).set({
        status: 'done',
        completedAt: now,
        updatedAt: now,
        metadata: { ...task.metadata as object, promotedToProject: projectId },
      }).where(eq(tasks.id, taskId)).run();
    });

    return NextResponse.json({
      projectId,
      projectName,
      phasesCreated: phases?.length || 0,
      tasksCreated: createdTasks.length,
    }, { status: 201 });
  } catch (error) {
    logger.error({ err: error }, 'Goal promotion failed');
    return ApiErrors.internal('Failed to promote goal', error);
  }
}
