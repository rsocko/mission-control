import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z, type ZodType } from 'zod';

const { mcGet, mcPatch, mcPost } = vi.hoisted(() => ({
  mcGet: vi.fn(),
  mcPatch: vi.fn(),
  mcPost: vi.fn(),
}));

vi.mock('@/mcp/client', () => ({
  mcGet,
  mcPatch,
  mcPost,
}));

import { registerTaskTools } from '@/mcp/tools/tasks';

interface ToolRegistration {
  name: string;
  schema: Record<string, ZodType>;
  metadata?: Record<string, unknown>;
  callback: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    _meta?: { ui?: { resourceUri?: string } };
  }>;
}

function registerTools() {
  const registrations: ToolRegistration[] = [];
  const server = {
    registerTool: vi.fn((
      name: string,
      metadata: { inputSchema: Record<string, ZodType> },
      callback: ToolRegistration['callback'],
    ) => {
      registrations.push({
        name,
        schema: metadata.inputSchema,
        metadata,
        callback,
      });
    }),
    tool: vi.fn((
      name: string,
      _description: string,
      schema: Record<string, ZodType>,
      callback: ToolRegistration['callback'],
    ) => {
      registrations.push({ name, schema, callback });
    }),
  };
  registerTaskTools(server as never);
  return registrations;
}

describe('mc_update_task', () => {
  beforeEach(() => {
    mcGet.mockReset();
    mcPatch.mockReset();
    mcPost.mockReset();
  });

  it('registers a narrow schema for widget-supported updates', () => {
    const registration = registerTools().find(tool => tool.name === 'mc_update_task');

    expect(registration).toBeDefined();
    const schema = z.object(registration!.schema).strict();
    expect(schema.parse({ id: 'task-1', status: 'done' })).toEqual({
      id: 'task-1',
      status: 'done',
    });
    expect(schema.safeParse({ id: 'task-1', status: 'invalid' }).success).toBe(false);
    expect(schema.safeParse({ id: 'task-1', title: 'Not allowed' }).success).toBe(false);
  });

  it('rejects an update with no mutable field', async () => {
    const registration = registerTools().find(tool => tool.name === 'mc_update_task')!;

    const result = await registration.callback({ id: 'task-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('provide status or priority');
    expect(mcPatch).not.toHaveBeenCalled();
  });

  it('encodes the task ID and returns the successful update', async () => {
    mcPatch.mockResolvedValue({ ok: true, status: 200, data: { success: true } });
    const registration = registerTools().find(tool => tool.name === 'mc_update_task')!;

    const result = await registration.callback({
      id: 'task/with spaces',
      status: 'done',
      priority: 'high',
    });

    expect(mcPatch).toHaveBeenCalledWith('/api/mcp/tasks/task%2Fwith%20spaces', {
      status: 'done',
      priority: 'high',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      id: 'task/with spaces',
      status: 'done',
      priority: 'high',
    });
  });

  describe('task widget text fallback', () => {
    beforeEach(() => {
      mcGet.mockReset();
      mcPost.mockReset();
    });

    it('keeps readable text content alongside task-card metadata', async () => {
      mcPost.mockResolvedValue({
        ok: true,
        status: 201,
        data: { id: 'task-1' },
      });
      const registration = registerTools().find(tool => tool.name === 'mc_create_task')!;

      const result = await registration.callback({ title: 'Ship MCP widgets' });

      expect(result.content[0].text).toContain('Created task:');
      expect(result.content[0].text).toContain('Ship MCP widgets');
      expect(registration.metadata).toMatchObject({
        _meta: {
          ui: {
            resourceUri: 'ui://mc/task-card',
            visibility: ['model'],
          },
        },
      });
      expect(result.structuredContent).toMatchObject({
        task: { id: 'task-1', title: 'Ship MCP widgets' },
      });
      expect(result._meta).toMatchObject({
        ui: { resourceUri: 'ui://mc/task-card' },
      });
    });

    it('keeps readable text content alongside task-list metadata', async () => {
      mcGet.mockResolvedValue({
        ok: true,
        status: 200,
        data: {
          tasks: [{ id: 'task-1', title: 'Ship MCP widgets', status: 'todo', priority: 'high' }],
          total: 1,
        },
      });
      const registration = registerTools().find(tool => tool.name === 'mc_search_tasks')!;

      const result = await registration.callback({ connectorType: 'scout', limit: 100, offset: 10 });

      expect(mcGet).toHaveBeenCalledWith(expect.stringContaining('source=scout'));
      expect(mcGet).toHaveBeenCalledWith(expect.stringContaining('limit=100'));
      expect(mcGet).toHaveBeenCalledWith(expect.stringContaining('offset=10'));
      expect(result.content[0].text).toContain('Found 1 tasks');
      expect(result.content[0].text).toContain('Ship MCP widgets');
      expect(registration.metadata).toMatchObject({
        _meta: {
          ui: {
            resourceUri: 'ui://mc/task-list',
            visibility: ['model'],
          },
        },
      });
      expect(result.structuredContent).toMatchObject({
        tasks: [{ id: 'task-1', title: 'Ship MCP widgets' }],
      });
      expect(result._meta).toMatchObject({
        ui: { resourceUri: 'ui://mc/task-list' },
      });
    });
  });

  it('surfaces API failures as MCP tool errors', async () => {
    mcPatch.mockResolvedValue({ ok: false, status: 403, error: 'Connector is read-only' });
    const registration = registerTools().find(tool => tool.name === 'mc_update_task')!;

    const result = await registration.callback({ id: 'task-1', priority: 'low' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connector is read-only');
  });
});
