/**
 * Embedded MCP Server endpoint — Streamable HTTP transport.
 *
 * Exposes Mission Control's MCP tools directly from the Next.js app so
 * external agents (Scout, Copilot, etc.) can connect to
 *   https://mission-control.example/api/mcp
 * without running a separate local MCP process.
 *
 * Stateless mode: each POST creates a fresh McpServer + transport, handles
 * the JSON-RPC request, then tears down. No session state is held.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { isAuthorizedMcpRequest, unauthorizedMcpResponse } from '@/mcp/auth';
import { createMissionControlMcpServer } from '@/mcp/create-server';

import logger from '@/lib/logger';

export const createMcpServer = createMissionControlMcpServer;

// ── POST  — JSON-RPC messages (tool calls, initialize, etc.) ────────────
export async function POST(request: Request) {
  if (!isAuthorizedMcpRequest(request)) {
    return unauthorizedMcpResponse();
  }

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // Stateless mode — no persistent state to clean up.
    // Transport & server are GC'd after the response stream drains.
    return response;
  } catch (error) {
    logger.error({ err: error }, 'MCP POST handler error');
    transport.close().catch(() => {});
    server.close().catch(() => {});
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

// ── GET — SSE stream (not needed for stateless, but required by spec) ───
export async function GET(request: Request) {
  if (!isAuthorizedMcpRequest(request)) {
    return unauthorizedMcpResponse();
  }

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    logger.error({ err: error }, 'MCP GET handler error');
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed in stateless mode' },
        id: null,
      }),
      { status: 405, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

// ── DELETE — session teardown (no-op in stateless mode) ─────────────────
export async function DELETE(request: Request) {
  if (!isAuthorizedMcpRequest(request)) {
    return unauthorizedMcpResponse();
  }

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    logger.error({ err: error }, 'MCP DELETE handler error');
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed in stateless mode' },
        id: null,
      }),
      { status: 405, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
