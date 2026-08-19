import { generateText } from 'ai';
import db from '@/db';
import { hubProjects, tasks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getAIModel, getAIRouteOutcome } from '../provider-factory';
import type { AIRouteOutcome } from '../types';

export async function autoAssignProjects(): Promise<{
  assignments: Array<{
    taskId: string;
    title: string;
    projectId: string;
    projectName: string;
    confidence: number;
  }>;
  routing?: AIRouteOutcome;
}> {
  const projects = await db.select().from(hubProjects);
  if (projects.length === 0) return { assignments: [] };

  const allTasks = await db.select().from(tasks).where(eq(tasks.status, 'todo')).limit(30);
  const route = getAIModel('project-assignment', {
    sources: allTasks.map(task => task.connectorType),
  });
  const projectList = projects
    .map(project => `- "${project.name}": ${project.description || 'no description'}`)
    .join('\n');
  const taskList = allTasks.slice(0, 15).map((task, index) => (
    `${index + 1}. "${task.title}" (source: ${task.connectorType}${task.sourceListName ? `, list: ${task.sourceListName}` : ''})`
  )).join('\n');
  const result = await generateText({
    model: route.model,
    system: `You assign tasks to projects. Available projects:\n${projectList}\n\nRespond ONLY in JSON: {"assignments": [{"index": 1, "project": "Project Name", "confidence": 0.9}]}. Only assign if confidence > 0.6.`,
    messages: [{ role: 'user', content: `Assign these tasks to the most appropriate project:\n\n${taskList}` }],
  });
  const routing = getAIRouteOutcome(route.context, result.response);

  try {
    const parsed = JSON.parse(result.text) as {
      assignments?: Array<{ index: number; project: string; confidence: number }>;
    };
    return {
      assignments: (parsed.assignments || [])
        .filter(assignment => assignment.confidence > 0.6)
        .map(assignment => {
          const project = projects.find(candidate => (
            candidate.name.toLowerCase() === assignment.project.toLowerCase()
          ));
          return {
            taskId: allTasks[assignment.index - 1]?.id || '',
            title: allTasks[assignment.index - 1]?.title || '',
            projectId: project?.id || '',
            projectName: assignment.project,
            confidence: assignment.confidence,
          };
        })
        .filter(assignment => assignment.taskId && assignment.projectId),
      routing,
    };
  } catch {
    return { assignments: [], routing };
  }
}
