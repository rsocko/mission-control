import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcPost } from '../client';

export function registerSyncTools(server: McpServer) {
  server.tool(
    'mc_trigger_sync',
    'Trigger a connector sync to pull latest tasks from external sources',
    {
      connectorId: z.string().optional().describe('Specific connector instance ID to sync (omit for all)'),
      full: z.boolean().optional().describe('Full sync instead of incremental (default: false)'),
    },
    async ({ connectorId, full }) => {
      const res = await mcPost<{ results: Array<{ connectorId: string; success: boolean; tasksAdded: number; tasksUpdated: number }> }>(
        '/api/sync',
        { connectorId, full: full || false }
      );

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }

      const results = res.data!.results;
      const summary = results.map(r =>
        `${r.connectorId}: ${r.success ? '✓' : '✗'} (+${r.tasksAdded} added, ~${r.tasksUpdated} updated)`
      ).join('\n');

      return { content: [{ type: 'text' as const, text: `Sync complete:\n${summary}` }] };
    }
  );
}
