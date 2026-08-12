import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { mcGet, mcPatch, mcPost } from '../client';
import { MC_PUBLIC_URL } from '../public-url';

/** Escape markdown link-breaking characters in text used inside [...] */
function mdEscapeTitle(s: string): string {
  return s.replace(/[[\]]/g, '\\$&');
}

export function registerTaskTools(server: McpServer) {
  server.tool(
    'mc_update_task',
    'Update a task status or priority in Mission Control',
    {
      id: z.string().trim().min(1).max(200).describe('Mission Control task ID'),
      status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional().describe('New task status'),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional().describe('New task priority'),
    },
    async ({ id, status, priority }) => {
      if (status === undefined && priority === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'Error: provide status or priority to update' }],
          isError: true,
        };
      }

      const updates = {
        ...(status !== undefined ? { status } : {}),
        ...(priority !== undefined ? { priority } : {}),
      };
      const res = await mcPatch<{ success: boolean }>(
        `/api/mcp/tasks/${encodeURIComponent(id)}`,
        updates,
      );

      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error updating task: ${res.error}` }],
          isError: true,
        };
      }

      const changedFields = Object.entries(updates)
        .map(([field, value]) => `${field}=${value}`)
        .join(', ');
      return {
        content: [{ type: 'text' as const, text: `Updated task ${id}: ${changedFields}` }],
        structuredContent: { id, ...updates },
      };
    },
  );

  registerAppTool(
    server,
    'mc_create_task',
    {
      description: 'Create a new task in Mission Control',
      inputSchema: {
        title: z.string().describe('Task title'),
        description: z.string().optional().describe('Task description/body'),
        priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional().describe('Task priority'),
        dueDate: z.string().optional().describe('Due date (ISO format, e.g. 2025-01-15)'),
        projectIds: z.array(z.string()).optional().describe('Hub project IDs to assign the task to'),
        tagSlugs: z.array(z.string()).optional().describe('Tag slugs to apply (created if needed)'),
        effort: z.number().optional().describe('Effort estimate (1-5 scale)'),
      },
      _meta: {
        ui: {
          resourceUri: 'ui://mc/task-card',
          visibility: ['model'],
        },
      },
    },
    async ({ title, description, priority, dueDate, projectIds, tagSlugs, effort }) => {
      const res = await mcPost<{ id?: string } & Record<string, unknown>>('/api/tasks', {
        title,
        description,
        priority: priority || 'none',
        dueDate,
        connectorType: 'local',
        projectIds,
        tagSlugs,
        effort,
      });

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }
      const data = res.data!;
      const taskUrl = data.id ? `${MC_PUBLIC_URL}/tasks/${data.id}` : null;
      const text = taskUrl
        ? `Created task: [${mdEscapeTitle(title)}](${taskUrl})\n\nPriority: ${priority || 'none'}${dueDate ? ` | Due: ${dueDate}` : ''}`
        : JSON.stringify(data, null, 2);
      const structuredContent = {
        task: { ...data, title, priority: priority || 'none', dueDate },
        mcBaseUrl: MC_PUBLIC_URL,
      };
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent,
        _meta: {
          ui: {
            resourceUri: 'ui://mc/task-card',
            url: `${MC_PUBLIC_URL}/mcp-widgets/task-card.html`,
            title: `Task: ${title}`,
            data: structuredContent,
          }
        }
      };
    }
  );

  registerAppTool(
    server,
    'mc_search_tasks',
    {
      description: 'Search tasks by text query, with optional filters',
      inputSchema: {
        query: z.string().optional().describe('Text search query (matches title, source ID)'),
        status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional().describe('Filter by status'),
        priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional().describe('Filter by priority'),
        connectorType: z.string().trim().min(1).max(100).optional().describe('Filter by connector type, such as "scout"'),
        projectId: z.string().optional().describe('Filter by hub project ID'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 20, maximum 200)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
      },
      _meta: {
        ui: {
          resourceUri: 'ui://mc/task-list',
          visibility: ['model'],
        },
      },
    },
    async ({ query, status, priority, connectorType, projectId, limit, offset }) => {
      const params = new URLSearchParams();
      if (query) params.set('search', query);
      if (status) params.set('status', status);
      if (priority) params.set('priority', priority);
      if (connectorType) params.set('source', connectorType);
      if (projectId) params.set('projectId', projectId);
      params.set('limit', String(limit || 20));
      params.set('offset', String(offset || 0));
      params.set('openOnly', 'true');

      const res = await mcGet<{ tasks: Array<{ id: string; title: string; priority?: string; status?: string; dueDate?: string } & Record<string, unknown>>; total: number }>(`/api/tasks?${params.toString()}`);

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }

      const data = res.data!;
      const taskLines = data.tasks.map(t => {
        const url = `${MC_PUBLIC_URL}/tasks/${t.id}`;
        const meta = [t.priority, t.status, t.dueDate].filter(Boolean).join(' | ');
        return `- [${mdEscapeTitle(t.title)}](${url})${meta ? ` — ${meta}` : ''}`;
      }).join('\n');

      const summary = `Found ${data.total} tasks (showing ${data.tasks.length}, offset ${offset || 0})`;
      const structuredContent = {
        tasks: data.tasks,
        mcBaseUrl: MC_PUBLIC_URL,
        listTitle: `Found ${data.total} tasks`,
      };
      return {
        content: [{ type: 'text' as const, text: `${summary}\n\n${taskLines}` }],
        structuredContent,
        _meta: {
          ui: {
            resourceUri: 'ui://mc/task-list',
            url: `${MC_PUBLIC_URL}/mcp-widgets/task-list.html`,
            title: `${data.tasks.length} Tasks`,
            data: structuredContent,
          }
        }
      };
    }
  );
}
