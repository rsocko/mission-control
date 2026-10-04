import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  claimNextDispatch,
  submitDispatchResult,
} from '@/lib/external-agents/service';

const claimIdentity = {
  dispatchId: z.string().min(1).max(200),
  claimToken: z.string().min(1).max(500),
};

const records = z.array(z.record(z.string(), z.unknown())).max(100).optional();

function toolResult(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2),
    }],
    structuredContent: data as Record<string, unknown>,
  };
}

export function registerAgentPullTools(server: McpServer, agentId: string) {
  server.tool(
    'mc_agent_claim_work',
    'Claim the next compatible Mission Control delegation for this worker. Returns no work when the queue is empty.',
    {
      leaseSeconds: z.number().int().min(60).max(3600).optional(),
    },
    async ({ leaseSeconds }) => {
      const claim = await claimNextDispatch(agentId, {
        leaseMs: (leaseSeconds ?? 300) * 1000,
      });
      return toolResult(claim ?? {
        available: false,
        message: 'No delegated work is currently available.',
      });
    },
  );

  server.tool(
    'mc_agent_update_progress',
    'Report progress and renew the active claim lease.',
    {
      ...claimIdentity,
      message: z.string().trim().min(1).max(1000),
      waitingForUser: z.boolean().optional(),
      leaseSeconds: z.number().int().min(60).max(3600).optional(),
    },
    async ({ dispatchId, claimToken, message, waitingForUser, leaseSeconds }) => {
      const result = await submitDispatchResult(
        dispatchId,
        {
          status: waitingForUser ? 'waiting_for_user' : 'in_progress',
          providerDetail: { progress: { message } },
        },
        { claimToken },
        { leaseMs: (leaseSeconds ?? 300) * 1000 },
      );
      return toolResult(result);
    },
  );

  server.tool(
    'mc_agent_complete_work',
    'Complete claimed work and return a concise structured result for Mission Control review.',
    {
      ...claimIdentity,
      summary: z.string().trim().min(1).max(32_000),
      tasks: records,
      phases: records,
      modifications: records,
      suggestedClosures: records,
    },
    async ({
      dispatchId,
      claimToken,
      summary,
      tasks,
      phases,
      modifications,
      suggestedClosures,
    }) => {
      const result = await submitDispatchResult(
        dispatchId,
        {
          status: 'completed',
          summary,
          tasks,
          phases,
          modifications,
          suggestedClosures,
        },
        { claimToken },
      );
      return toolResult(result);
    },
  );

  server.tool(
    'mc_agent_fail_work',
    'Fail claimed work with a sanitized explanation that helps the user recover.',
    {
      ...claimIdentity,
      errorMessage: z.string().trim().min(1).max(4096),
    },
    async ({ dispatchId, claimToken, errorMessage }) => {
      const result = await submitDispatchResult(
        dispatchId,
        { status: 'failed', errorMessage },
        { claimToken },
      );
      return toolResult(result);
    },
  );
}
