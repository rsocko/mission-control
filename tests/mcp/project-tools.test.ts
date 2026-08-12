import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z, type ZodType } from 'zod';

const { mcGet, mcPost } = vi.hoisted(() => ({
  mcGet: vi.fn(),
  mcPost: vi.fn(),
}));

vi.mock('@/mcp/client', () => ({ mcGet, mcPost }));

import { registerProjectTools } from '@/mcp/tools/projects';

interface ToolRegistration {
  name: string;
  schema: Record<string, ZodType>;
  callback: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function registerTools() {
  const registrations: ToolRegistration[] = [];
  const server = {
    tool: vi.fn((
      name: string,
      _description: string,
      schema: Record<string, ZodType>,
      callback: ToolRegistration['callback'],
    ) => registrations.push({ name, schema, callback })),
  };
  registerProjectTools(server as never);
  return registrations;
}

describe('mc_add_tasks_to_project', () => {
  beforeEach(() => {
    mcGet.mockReset();
    mcPost.mockReset();
  });

  it('requires at least one task ID', () => {
    const registration = registerTools().find((tool) => tool.name === 'mc_add_tasks_to_project')!;
    const schema = z.object(registration.schema).strict();

    expect(schema.safeParse({ projectId: 'project-1', taskIds: [] }).success).toBe(false);
  });

  it('adds unique existing tasks through the policy-enforced membership route', async () => {
    mcPost.mockResolvedValue({ ok: true, status: 200, data: { success: true } });
    const registration = registerTools().find((tool) => tool.name === 'mc_add_tasks_to_project')!;

    const result = await registration.callback({
      projectId: 'project/with spaces',
      taskIds: ['remote-1', 'remote-2', 'remote-1'],
    });

    expect(mcPost).toHaveBeenCalledTimes(2);
    expect(mcPost).toHaveBeenNthCalledWith(
      1,
      '/api/hub-projects/project%2Fwith%20spaces/tasks',
      { taskId: 'remote-1' },
    );
    expect(mcPost).toHaveBeenNthCalledWith(
      2,
      '/api/hub-projects/project%2Fwith%20spaces/tasks',
      { taskId: 'remote-2' },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ added: 2 });
  });

  it('reports per-task failures without hiding successful memberships', async () => {
    mcPost
      .mockResolvedValueOnce({ ok: true, status: 200, data: { success: true } })
      .mockResolvedValueOnce({ ok: false, status: 403, error: 'Projects cannot be changed' });
    const registration = registerTools().find((tool) => tool.name === 'mc_add_tasks_to_project')!;

    const result = await registration.callback({
      projectId: 'project-1',
      taskIds: ['allowed', 'blocked'],
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      added: 1,
      results: [
        { taskId: 'allowed', success: true },
        { taskId: 'blocked', success: false, error: 'Projects cannot be changed' },
      ],
    });
  });
});
