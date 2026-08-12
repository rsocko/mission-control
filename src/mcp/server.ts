#!/usr/bin/env node
/**
 * Mission Control MCP Server
 *
 * Exposes Mission Control's REST APIs as MCP tools for AI agents.
 * Run with: npx tsx src/mcp/server.ts
 *
 * Environment variables:
 *   MC_BASE_URL  — Base URL of Mission Control (default: http://localhost:3099)
 *   MC_PUBLIC_URL — Public URL for task links in responses (falls back to NEXTAUTH_URL, NEXT_PUBLIC_BASE_URL, MC_BASE_URL)
 *   MC_API_KEY   — API key for authentication (optional in local dev)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMissionControlMcpServer } from './create-server';

const server = createMissionControlMcpServer();

// Start the server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal error: ${err}\n`);
  process.exit(1);
});
