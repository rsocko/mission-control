import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcPost } from '../client';
import {
  workTodoAckSchema,
  workTodoIngestSchema,
} from '@/lib/connectors/work-todo/contracts';

export function registerWorkTodoTools(server: McpServer) {
  server.tool(
    'mc_todo_sync_pull_request',
    'Create the exact standard or extended Power Automate pull envelope. Opaque delta links are sensitive and must be passed unchanged without printing or summarizing them.',
    { connectorInstanceId: z.string().min(1).max(100) },
    async (input) => {
      const response = await mcPost<Record<string, unknown>>('/api/work-todo/pull-request', input);
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: `Work To Do pull request failed: ${response.error}` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: 'Work To Do pull envelope prepared. Pass structuredContent unchanged; never print opaque delta links.',
        }],
        structuredContent: response.data,
      };
    },
  );

  server.tool(
    'mc_todo_sync_ingest',
    'Ingest an unchanged Microsoft To Do - Work snapshot or Graph delta envelope. This is deterministic transport; do not summarize or rewrite fields.',
    { payload: workTodoIngestSchema },
    async ({ payload }) => {
      const response = await mcPost<Record<string, unknown>>('/api/work-todo/ingest', payload);
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: `Work To Do ingest failed: ${response.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response.data) }],
        structuredContent: response.data,
      };
    },
  );

  server.tool(
    'mc_todo_sync_changes',
    'Lease pending Mission Control edits for deterministic write-back to the configured Work To Do Power Automate flow.',
    {
      connectorInstanceId: z.string().min(1).max(100),
      limit: z.number().int().min(1).max(100).optional(),
      leaseSeconds: z.number().int().min(30).max(1_800).optional(),
    },
    async (input) => {
      const response = await mcPost<Record<string, unknown>>('/api/work-todo/changes', input);
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: `Work To Do change lease failed: ${response.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response.data) }],
        structuredContent: response.data,
      };
    },
  );

  server.tool(
    'mc_todo_sync_ack',
    'Acknowledge per-item Work To Do write-back outcomes. Successful items settle; failed and skipped items remain retryable.',
    workTodoAckSchema.shape,
    async (input) => {
      const response = await mcPost<Record<string, unknown>>('/api/work-todo/ack', input);
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: `Work To Do acknowledgement failed: ${response.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response.data) }],
        structuredContent: response.data,
      };
    },
  );
}
