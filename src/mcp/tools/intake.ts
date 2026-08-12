import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcPost } from '../client';

export function registerIntakeTools(server: McpServer) {
  server.tool(
    'mc_intake_document',
    'Parse a document (markdown, text, or structured content) into project tasks using AI. Can create a new project or append phases/tasks to an existing one.',
    {
      content: z.string().describe('Document content (markdown, plain text, or structured text)'),
      repo: z.string().describe('Target GitHub repo in owner/repo format for issue creation'),
      projectId: z.string().optional().describe('Existing hub project ID to append phases and tasks to. If omitted, a new project is created.'),
      format: z.enum(['markdown', 'text', 'outline']).optional().describe('Content format hint (default: markdown)'),
      category: z.string().optional().describe('Optional project category (e.g. "audit", "development"). If not specified, the project will be uncategorized'),
    },
    async ({ content, repo, projectId, format, category }) => {
      const res = await mcPost<{ tasks?: unknown[]; message?: string }>('/api/ai/intake-document', {
        document: content,
        repo,
        existingProjectId: projectId,
        format: format || 'markdown',
        category,
        mode: 'execute',
      });

      if (!res.ok) {
        // If the endpoint doesn't exist yet, provide helpful feedback
        if (res.status === 404) {
          return {
            content: [{
              type: 'text' as const,
              text: 'The intake-document endpoint is not yet available. Ensure Mission Control is running and the /api/ai/intake-document route is implemented.',
            }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }] };
    }
  );
}
