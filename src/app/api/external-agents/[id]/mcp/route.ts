import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  ExternalAgentError,
  isExternalAgentError,
} from '@/lib/external-agents/errors';
import {
  externalAgentErrorResponse,
  requireAgentAuthentication,
} from '@/lib/external-agents/http';
import { createAgentPullMcpServer } from '@/mcp/create-agent-pull-server';
import logger from '@/lib/logger';

type Context = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Context) {
  try {
    const id = (await params).id;
    const agent = await requireAgentAuthentication(request, id);
    if (agent.transport !== 'pull') {
      throw new ExternalAgentError(
        'Agent does not use pull transport',
        'TRANSPORT_INVALID',
        409,
      );
    }
    const server = createAgentPullMcpServer(agent.id);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    if (!isExternalAgentError(error)) {
      logger.error({ err: error }, 'Agent pull MCP handler error');
    }
    return externalAgentErrorResponse(error);
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
