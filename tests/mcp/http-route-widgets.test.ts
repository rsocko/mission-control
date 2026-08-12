import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer, POST } from '@/app/api/mcp/route';
import { TRIAGE_SUMMARY_RESOURCE_URI } from '@/lib/triage/summary-contract';

const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

let client: Client | undefined;
let server: McpServer | undefined;

function parseSseMessage(body: string) {
  const dataLine = body.split(/\r?\n/).find(line => line.startsWith('data: '));
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown>;
}

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

describe('remote MCP widget discovery', () => {
  it('serves resource discovery from the stateless HTTP endpoint', async () => {
    const response = await POST(new Request('https://mc.example/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/list',
        params: {},
      }),
    }));

    expect(response.status).toBe(200);
    expect(parseSseMessage(await response.text())).toMatchObject({
      result: {
        resources: expect.arrayContaining([
          expect.objectContaining({ uri: TRIAGE_SUMMARY_RESOURCE_URI }),
        ]),
      },
    });

    const toolsResponse = await POST(new Request('https://mc.example/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    }));
    expect(toolsResponse.status).toBe(200);
    expect(parseSseMessage(await toolsResponse.text())).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'mc_search_triage',
            _meta: expect.objectContaining({
              ui: expect.objectContaining({
                resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
                visibility: ['model'],
              }),
            }),
          }),
        ]),
      },
    });

    const readResponse = await POST(new Request('https://mc.example/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: TRIAGE_SUMMARY_RESOURCE_URI },
      }),
    }));
    expect(readResponse.status).toBe(200);
    expect(parseSseMessage(await readResponse.text())).toMatchObject({
      result: {
        contents: [{
          uri: TRIAGE_SUMMARY_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: expect.stringContaining('<!DOCTYPE html>'),
        }],
      },
    });
  });

  it('exposes standards-compliant tool descriptors and full UI resources', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createMcpServer();
    client = new Client(
      { name: 'remote-widget-test', version: '1.0.0' },
      { capabilities: {} },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === 'mc_search_triage')).toMatchObject({
      _meta: {
        ui: {
          resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
          visibility: ['model'],
        },
      },
    });
    expect(tools.tools.find(tool => tool.name === 'mc_create_task')).toMatchObject({
      _meta: {
        ui: {
          resourceUri: 'ui://mc/task-card',
          visibility: ['model'],
        },
      },
    });
    expect(tools.tools.find(tool => tool.name === 'mc_search_tasks')).toMatchObject({
      _meta: {
        ui: {
          resourceUri: 'ui://mc/task-list',
          visibility: ['model'],
        },
      },
    });
    expect(tools.tools.find(tool => tool.name === 'mc_scout_push_tasks')).toMatchObject({
      _meta: {
        ui: {
          resourceUri: 'ui://mc/task-list',
          visibility: ['model'],
        },
      },
    });

    const listed = await client.listResources();
    expect(listed.resources.map(resource => resource.uri)).toEqual([
      'ui://mc/task-card',
      'ui://mc/task-list',
      TRIAGE_SUMMARY_RESOURCE_URI,
    ]);
    expect(listed.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'ui://mc/task-card', mimeType: RESOURCE_MIME_TYPE }),
      expect.objectContaining({ uri: 'ui://mc/task-list', mimeType: RESOURCE_MIME_TYPE }),
      expect.objectContaining({ uri: TRIAGE_SUMMARY_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE }),
    ]));

    for (const uri of listed.resources.map(resource => resource.uri)) {
      const result = await client.readResource({ uri });
      expect(result.contents[0]).toMatchObject({
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: expect.stringContaining('<!DOCTYPE html>'),
      });
      expect(result.contents[0]).toMatchObject({
        _meta: { ui: { prefersBorder: false } },
      });
      expect('text' in result.contents[0]).toBe(true);
      if ('text' in result.contents[0]) {
        expect(result.contents[0].text).not.toContain('http-equiv="refresh"');
      }
    }
  });
});
