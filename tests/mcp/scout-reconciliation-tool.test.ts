import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z, type ZodType } from 'zod';

const { mcPost } = vi.hoisted(() => ({ mcPost: vi.fn() }));

vi.mock('@/mcp/client', () => ({
  mcGet: vi.fn(),
  mcPost,
}));

import { registerScoutTools } from '@/mcp/tools/scout';

interface Registration {
  name: string;
  schema: Record<string, ZodType>;
  metadata?: Record<string, unknown>;
  callback: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }>;
}

function registrations() {
  const tools: Registration[] = [];
  registerScoutTools({
    registerTool: vi.fn((name, metadata, callback) => {
      tools.push({
        name,
        schema: metadata.inputSchema,
        metadata,
        callback,
      } as Registration);
    }),
    tool: vi.fn((name, _description, schema, callback) => {
      tools.push({ name, schema, callback } as Registration);
    }),
  } as never);
  return tools;
}

describe('mc_scout_reconcile', () => {
  beforeEach(() => {
    mcPost.mockReset();
  });

  it('registers a bounded structured-evidence contract', () => {
    const tool = registrations().find((registration) => registration.name === 'mc_scout_reconcile')!;
    const schema = z.object(tool.schema).strict();
    expect(schema.safeParse({
      sourceIdentity: 'automation-run-1',
      signals: [{
        signalId: 'signal-1',
        taskId: 'task-1',
        sourceType: 'planner',
        kind: 'planner-completed',
        occurredAt: '2026-08-05T11:00:00.000Z',
        summary: 'Synthetic Planner item completed',
        sourceRefHash: '0'.repeat(64),
      }],
    }).success).toBe(true);
    expect(schema.safeParse({
      sourceIdentity: 'automation-run-1',
      signals: [{
        signalId: 'signal-1',
        taskId: 'task-1',
        sourceType: 'planner',
        kind: 'made-up-signal',
        occurredAt: '2026-08-05T11:00:00.000Z',
        summary: 'Synthetic evidence',
        sourceRefHash: '0'.repeat(64),
      }],
    }).success).toBe(false);
  });

  it('advertises Scout pushes as a model-visible task-list app', () => {
    const tool = registrations().find((registration) => registration.name === 'mc_scout_push_tasks')!;

    expect(tool.metadata).toMatchObject({
      _meta: {
        ui: {
          resourceUri: 'ui://mc/task-list',
          visibility: ['model'],
        },
      },
    });
  });

  it('uses the task-list resource and schema for a single pushed task', async () => {
    mcPost.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        created: 1,
        updated: 0,
        triaged: 0,
        skipped: 0,
        total: 1,
        items: [{ sourceId: 'scout:email:1', mcTaskId: 'task-1', action: 'created' }],
      },
    });
    const tool = registrations().find((registration) => registration.name === 'mc_scout_push_tasks')!;

    const result = await tool.callback({
      items: [{
        sourceId: 'scout:email:1',
        sourceType: 'email',
        title: 'Reply to the launch thread',
      }],
    });

    expect(result.structuredContent).toMatchObject({
      tasks: [{ id: 'task-1', title: 'Reply to the launch thread' }],
    });
    expect(result._meta).toMatchObject({
      ui: {
        resourceUri: 'ui://mc/task-list',
        data: {
          tasks: [{ id: 'task-1', title: 'Reply to the launch thread' }],
        },
      },
    });
  });

  it('uses the reconciliation API and surfaces failures as tool errors', async () => {
    const tool = registrations().find((registration) => registration.name === 'mc_scout_reconcile')!;
    mcPost.mockResolvedValueOnce({ ok: false, status: 409, error: 'Run already in progress' });
    const failed = await tool.callback({
      sourceIdentity: 'automation-run-1',
      signals: [],
    });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('Run already in progress');

    mcPost.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        runId: 'run-1',
        idempotentReplay: false,
        dryRun: false,
        reconciled: [],
        summary: {
          autoCompleted: 0,
          suggestedComplete: 0,
          escalated: 0,
          unchanged: 1,
          ignoredSignals: 0,
        },
      },
    });
    const succeeded = await tool.callback({
      sourceIdentity: 'automation-run-1',
      signals: [],
    });
    expect(succeeded.isError).toBeUndefined();
    expect(mcPost).toHaveBeenLastCalledWith('/api/scout/reconcile', expect.objectContaining({
      source: 'automation',
      sourceIdentity: 'automation-run-1',
    }));
  });

  it('keeps the schedule on the safe API contract instead of direct mutation', () => {
    const automation = readFileSync(
      resolve(process.cwd(), 'clients/scout-skill/automations/scout-reconciliation.json'),
      'utf8',
    );
    expect(automation).toContain('mc_scout_reconcile');
    expect(automation).toContain('Do not call mc_update_task');
    expect(automation).toContain('Do not send message bodies');
  });
});
