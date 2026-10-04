import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgentPullTools } from './tools/agent-pull';

export function createAgentPullMcpServer(agentId: string): McpServer {
  const server = new McpServer({
    name: 'mission-control-agent-pull',
    version: '1.0.0',
  });
  registerAgentPullTools(server, agentId);
  return server;
}
