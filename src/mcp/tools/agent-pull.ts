import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  claimNextDispatch,
  requestDispatchInteraction,
  submitDispatchResult,
} from '@/lib/external-agents/service';
import {
  getScoutWorkerHealth,
  getScoutWorkerIdentity,
} from '@/lib/external-agents/scout-worker';

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
    'mc_agent_identity',
    'Verify this worker identity, connector binding, negotiated capabilities, and data policy.',
    {},
    async () => toolResult(await getScoutWorkerIdentity(agentId)),
  );

  server.tool(
    'mc_agent_health',
    'Check worker readiness, protocol versions, connectivity, and supported activation modes.',
    {},
    async () => toolResult(await getScoutWorkerHealth(agentId)),
  );

  server.tool(
    'mc_agent_claim_work',
    'Claim the next compatible Mission Control delegation for this worker. Returns no work when the queue is empty.',
    {
      leaseSeconds: z.number().int().min(60).max(3600).optional(),
      dispatchId: z.string().trim().min(1).max(200).optional(),
    },
    async ({ leaseSeconds, dispatchId }) => {
      const claim = await claimNextDispatch(agentId, {
        leaseMs: (leaseSeconds ?? 300) * 1000,
        dispatchId,
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
      leaseSeconds: z.number().int().min(60).max(3600).optional(),
    },
    async ({ dispatchId, claimToken, message, leaseSeconds }) => {
      const result = await submitDispatchResult(
        dispatchId,
        {
          status: 'in_progress',
          providerDetail: { progress: { message } },
        },
        { claimToken },
        { leaseMs: (leaseSeconds ?? 300) * 1000 },
      );
      return toolResult(result);
    },
  );

  server.tool(
    'mc_agent_request_input',
    'Create a durable user question or approval, release the claim, and resume only after Mission Control records a resolution.',
    {
      ...claimIdentity,
      kind: z.enum(['question', 'approval']),
      prompt: z.string().trim().min(1).max(2000),
      choices: z.array(z.string().trim().min(1).max(200)).min(2).max(20).optional(),
      continuationPolicy: z.enum([
        'resume_same_dispatch',
        'require_new_dispatch',
      ]).optional(),
    },
    async ({
      dispatchId,
      claimToken,
      kind,
      prompt,
      choices,
      continuationPolicy,
    }) => toolResult({
      interaction: await requestDispatchInteraction(
        dispatchId,
        claimToken,
        { kind, prompt, choices, continuationPolicy },
      ),
      message: 'Input request recorded. Stop work and discard this claim token.',
    }),
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
