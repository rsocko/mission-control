import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcGet, mcPost } from '../client';

export function registerPhaseTools(server: McpServer) {
  server.tool(
    'mc_create_phase',
    'Create a new phase within a hub project',
    {
      projectId: z.string().describe('Hub project ID to add the phase to'),
      name: z.string().describe('Phase name'),
      description: z.string().optional().describe('Phase description'),
      color: z.string().optional().describe('Hex color for the phase'),
      estimatedDays: z.number().optional().describe('Estimated days to complete'),
      targetStart: z.string().optional().describe('Target start date (ISO)'),
      targetEnd: z.string().optional().describe('Target end date (ISO)'),
      sortOrder: z.number().optional().describe('Sort order (lower = earlier)'),
    },
    async ({ projectId, name, description, color, estimatedDays, targetStart, targetEnd, sortOrder }) => {
      const res = await mcPost<{ phase: unknown }>('/api/project-phases', {
        projectId,
        name,
        description,
        color,
        estimatedDays,
        targetStart,
        targetEnd,
        sortOrder,
      });

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }] };
    }
  );

  server.tool(
    'mc_assign_items_to_phase',
    'Assign one or more tasks to a project phase (bulk)',
    {
      phaseId: z.string().describe('Phase ID to assign tasks to'),
      taskIds: z.array(z.string()).describe('Array of task IDs to assign'),
    },
    async ({ phaseId, taskIds }) => {
      const results: Array<{ taskId: string; success: boolean; error?: string }> = [];

      for (const taskId of taskIds) {
        const res = await mcPost<{ item: unknown }>(`/api/project-phases/${encodeURIComponent(phaseId)}/items`, {
          taskId,
        });
        if (res.ok) {
          results.push({ taskId, success: true });
        } else {
          results.push({ taskId, success: false, error: res.error });
        }
      }

      const allSuccess = results.every(r => r.success);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ assigned: results.length, results }, null, 2) }],
        isError: !allSuccess,
      };
    }
  );
}
