import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import db from '@/db';
import { tasks, hubProjects, projectPhases } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';

export const reasoningTools = {
  suggestDayPlan: tool({
    description: 'Suggest tasks to focus on today based on priorities, due dates, and workload',
    inputSchema: zodSchema(z.object({
      availableMinutes: z.number().optional().describe('How many minutes the user has available'),
      focusArea: z.string().optional().describe('Optional project or tag to prioritize'),
    })),
    execute: async ({ availableMinutes, focusArea }) => {
      const today = getLocalToday();
      const allOpen = await db.select().from(tasks)
        .where(eq(tasks.status, 'todo'))
        .orderBy(desc(tasks.priority));

      const overdue = allOpen.filter(t => t.dueDate && t.dueDate < today);
      const dueToday = allOpen.filter(t => t.dueDate === today);
      const critical = allOpen.filter(t => t.priority === 'critical' && !overdue.includes(t));
      const high = allOpen.filter(t => t.priority === 'high' && !overdue.includes(t) && !dueToday.includes(t));

      const suggestions = [...overdue, ...dueToday, ...critical, ...high].slice(0, 8);

      return {
        suggestions: suggestions.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          microStatus: t.microStatus,
          priority: t.priority,
          dueDate: t.dueDate,
          source: t.connectorType,
          reason: overdue.includes(t) ? 'overdue' : dueToday.includes(t) ? 'due today' : `${t.priority} priority`,
        })),
        totalOverdue: overdue.length,
        totalOpen: allOpen.length,
        availableMinutes,
      };
    },
  }),

  getProjects: tool({
    description: 'Get all hub projects with their descriptions and task counts',
    inputSchema: zodSchema(z.object({
      _placeholder: z.boolean().optional(),
    })),
    execute: async () => {
      const projects = await db.select().from(hubProjects);
      return projects.map(p => ({ id: p.id, name: p.name, description: p.description, color: p.color }));
    },
  }),

  planPhases: tool({
    description: 'Plan phases for a project or across all projects. Uses AI to group tasks into sequential phases.',
    inputSchema: zodSchema(z.object({
      projectName: z.string().optional().describe('Name of the project to plan. Omit for cross-project planning.'),
      phaseCount: z.number().optional().describe('Number of phases to suggest (2-6)'),
      context: z.string().optional().describe('Additional guidance for the AI planner'),
    })),
    execute: async ({ projectName, phaseCount, context }) => {
      let projectId: string | null = null;

      if (projectName) {
        const matchingProjects = await db.select().from(hubProjects);
        const match = matchingProjects.find(p =>
          p.name.toLowerCase().includes(projectName.toLowerCase()),
        );
        if (!match) {
          return { success: false, error: `No project found matching "${projectName}". Available projects: ${matchingProjects.map(p => p.name).join(', ')}` };
        }
        projectId = match.id;
      }

      const requestBody = {
        projectId,
        phaseCount: phaseCount || undefined,
        context: context || undefined,
      };

      try {
        const baseUrl = process.env.MC_INTERNAL_URL || process.env.NEXTAUTH_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`;
        const response = await fetch(`${baseUrl}/api/project-phases/ai-suggest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          return { success: false, error: (errorData as { error?: string }).error || 'Failed to generate phase plan' };
        }

        const data = (await response.json()) as { proposal?: { phases: Array<{ name: string; description: string; taskIds: string[]; reasoning: string; estimatedDays: number }>; overallReasoning: string; suggestedNewTasks: Array<{ title: string; description: string; phase: string; reasoning: string }>; suggestedClosures: Array<{ taskId: string; title: string; reasoning: string }> } };
        if (!data.proposal) {
          return { success: false, error: 'No proposal returned' };
        }

        return {
          success: true,
          planSummary: data.proposal.overallReasoning,
          phases: data.proposal.phases.map(p => ({
            name: p.name,
            description: p.description,
            taskCount: p.taskIds.length,
            estimatedDays: p.estimatedDays,
            reasoning: p.reasoning,
          })),
          suggestedNewTasks: data.proposal.suggestedNewTasks,
          suggestedClosures: data.proposal.suggestedClosures,
          actionUrl: `/projects`,
          message: `I've generated a phase plan with ${data.proposal.phases.length} phases. You can review and apply it on the Projects page.`,
        };
      } catch (err) {
        return { success: false, error: `Failed to generate plan: ${err}` };
      }
    },
  }),

  getProjectPhases: tool({
    description: 'Get existing phases for a project or across all projects',
    inputSchema: zodSchema(z.object({
      projectName: z.string().optional().describe('Project name to filter by'),
    })),
    execute: async ({ projectName }) => {
      let allPhases = await db.select().from(projectPhases).orderBy(projectPhases.sortOrder);

      if (projectName) {
        const matchingProjects = await db.select().from(hubProjects);
        const match = matchingProjects.find(p =>
          p.name.toLowerCase().includes(projectName.toLowerCase()),
        );
        if (match) {
          allPhases = allPhases.filter(p => p.projectId === match.id);
        }
      }

      return allPhases.map(p => ({
        id: p.id,
        name: p.name,
        projectId: p.projectId,
        status: p.status,
        estimatedDays: p.estimatedDays,
        startAfterPhaseId: p.startAfterPhaseId,
      }));
    },
  }),
};
