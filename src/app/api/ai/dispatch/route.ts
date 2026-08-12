import {
  dispatchAgent,
  AgentType,
  MaintenanceAgentConflictError,
} from '@/lib/ai/agents';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * POST /api/ai/dispatch — Run an agent to perform automated actions
 * Body: { agent: AgentType, dryRun?: boolean, customInstruction?: string, document?: string, repo?: string, projectName?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { agent, dryRun, customInstruction, document, documentUrl, filePath, repo, projectName, cursor } = body;

    if (!agent) {
      return ApiErrors.badRequest('agent type is required');
    }
    if (cursor !== undefined && typeof cursor !== 'string') {
      return ApiErrors.badRequest('cursor must be a string');
    }

    const result = await dispatchAgent(agent as AgentType, {
      dryRun,
      customInstruction,
      document,
      documentUrl,
      filePath,
      repo,
      projectName,
      cursor,
      signal: request.signal,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof MaintenanceAgentConflictError) {
      return ApiErrors.conflict(error.message);
    }
    aiLogger.error({ err: error }, 'Agent dispatch request failed');
    return ApiErrors.internal('Agent failed', error);
  }
}
