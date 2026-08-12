import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIntakeTools } from './tools/intake';
import { registerPhaseTools } from './tools/phases';
import { registerProjectTools } from './tools/projects';
import { registerScoutTools } from './tools/scout';
import { registerSyncTools } from './tools/sync';
import { registerTagTools } from './tools/tags';
import { registerTaskTools } from './tools/tasks';
import { registerTriageTools } from './tools/triage';
import { registerWorkTodoTools } from './tools/work-todo';
import { registerWidgetResources } from './widgets';

export function createMissionControlMcpServer(): McpServer {
  const server = new McpServer({
    name: 'mission-control',
    version: '1.0.0',
  });

  registerProjectTools(server);
  registerPhaseTools(server);
  registerTaskTools(server);
  registerTagTools(server);
  registerSyncTools(server);
  registerTriageTools(server);
  registerIntakeTools(server);
  registerScoutTools(server);
  registerWorkTodoTools(server);
  registerWidgetResources(server);

  return server;
}
