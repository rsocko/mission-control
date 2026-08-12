import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcGet, mcPost } from '../client';

export function registerProjectTools(server: McpServer) {
  server.tool(
    'mc_create_project',
    'Create a new hub project in Mission Control',
    {
      name: z.string().describe('Project name'),
      description: z.string().optional().describe('Project description'),
      color: z.string().optional().describe('Hex color (e.g. #3b82f6)'),
      icon: z.string().optional().describe('Icon identifier'),
      category: z.string().optional().describe('Project category'),
      targetDate: z.string().optional().describe('Target completion date (ISO)'),
    },
    async ({ name, description, color, icon, category, targetDate }) => {
      const res = await mcPost<{ id: string }>('/api/hub-projects', {
        name,
        description,
        color,
        icon,
        category,
        targetDate,
      });

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'mc_add_tasks_to_project',
    'Add one or more existing tasks to a hub project (bulk)',
    {
      projectId: z.string().describe('Hub project ID to add tasks to'),
      taskIds: z.array(z.string()).min(1).describe('Existing task IDs to add'),
    },
    async ({ projectId, taskIds }) => {
      const results: Array<{ taskId: string; success: boolean; error?: string }> = [];

      for (const taskId of [...new Set(taskIds)]) {
        const res = await mcPost<{ success: boolean }>(
          `/api/hub-projects/${encodeURIComponent(projectId)}/tasks`,
          { taskId },
        );
        results.push(res.ok
          ? { taskId, success: true }
          : { taskId, success: false, error: res.error });
      }

      const added = results.filter((result) => result.success).length;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ added, results }, null, 2),
        }],
        isError: added !== results.length,
      };
    },
  );

  server.tool(
    'mc_get_project',
    'Get details of a specific hub project',
    {
      projectId: z.string().describe('Project ID (e.g. proj-my-project)'),
    },
    async ({ projectId }) => {
      const res = await mcGet<{ project: unknown }>(`/api/hub-projects/${encodeURIComponent(projectId)}`);

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'mc_list_projects',
    'List all hub projects in Mission Control',
    {
      includeHidden: z.boolean().optional().describe('Include hidden projects (default: false)'),
    },
    async ({ includeHidden }) => {
      const params = includeHidden ? '?includeHidden=true' : '';
      const res = await mcGet<{ projects: unknown[] }>(`/api/hub-projects${params}`);

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }] };
    }
  );
}
