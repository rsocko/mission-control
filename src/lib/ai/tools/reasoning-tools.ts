import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';
import { getLocalToday } from '@/lib/utils/date';
import { listHubProjects, listProjectPhases } from '@/lib/projects/organization-service';

const DAY_PLAN_SUGGESTION_LIMIT = 8;

export const reasoningTools = {
  suggestDayPlan: tool({
    description: 'Suggest tasks to focus on today based on priorities, due dates, and workload',
    inputSchema: zodSchema(z.object({
      availableMinutes: z.number().optional().describe('How many minutes the user has available'),
      focusArea: z.string().optional().describe('Optional project or tag to prioritize'),
    })),
    execute: async ({ availableMinutes, focusArea }) => {
      const today = getLocalToday();
      const persistence = await getAIWorkflowPersistence();
      // The adapter selects the real overdue/due-today/critical/high
      // candidates within a bounded row budget and returns exact totals, so
      // no important task can be lost to a truncated prefix of open tasks.
      const { suggestions, counts } = await persistence.dayPlan.listSuggestions({
        today,
        limit: DAY_PLAN_SUGGESTION_LIMIT,
      });

      return {
        suggestions: suggestions.map((task) => ({
          id: task.id,
          title: task.title,
          priority: task.priority,
          dueDate: task.dueDate,
          source: task.connectorType,
          reason: task.reason === 'overdue'
            ? 'overdue'
            : task.reason === 'due-today'
              ? 'due today'
              : `${task.priority} priority`,
        })),
        totalOverdue: counts.overdue,
        totalDueToday: counts.dueToday,
        totalOpen: counts.open,
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
      const projects = await listHubProjects({ includeHidden: true, includePhases: false });
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
        const matchingProjects = await listHubProjects({ includeHidden: true, includePhases: false });
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
      let matchedProjectId: string | null = null;
      if (projectName) {
        const matchingProjects = await listHubProjects({ includeHidden: true, includePhases: false });
        const match = matchingProjects.find(p =>
          p.name.toLowerCase().includes(projectName.toLowerCase()),
        );
        if (match) {
          matchedProjectId = match.id;
        }
      }
      // `crossProject: true` means "phases with no project" — the default here
      // is every phase, narrowed to one project only when a name matched.
      const allPhases = await listProjectPhases({
        projectId: matchedProjectId,
        crossProject: false,
      });

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
