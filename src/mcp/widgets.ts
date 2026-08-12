import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { MC_PUBLIC_URL } from './public-url';
import { TRIAGE_SUMMARY_RESOURCE_URI } from '@/lib/triage/summary-contract';

const widgetHtml = new Map<string, Promise<string>>();

function loadWidgetHtml(fileName: string): Promise<string> {
  const cached = widgetHtml.get(fileName);
  if (cached) return cached;

  const pending = readFile(
    join(process.cwd(), 'public', 'mcp-widgets', fileName),
    'utf8',
  );
  widgetHtml.set(fileName, pending);
  return pending;
}

/**
 * Registers MCP Apps UI resources for interactive widgets.
 * These resources are referenced in tool _meta.ui to trigger widget rendering
 * in MCP Apps-compatible hosts (M365 Copilot, ChatGPT).
 */
export function registerWidgetResources(server: McpServer) {
  registerAppResource(
    server,
    'task-card-widget',
    'ui://mc/task-card',
    {
      description: 'Interactive task card widget',
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [{
        uri: 'ui://mc/task-card',
        mimeType: RESOURCE_MIME_TYPE,
        text: await loadWidgetHtml('task-card.html'),
        _meta: { ui: { prefersBorder: false } },
      }]
    })
  );

  registerAppResource(
    server,
    'task-list-widget',
    'ui://mc/task-list',
    {
      description: 'Interactive task list widget',
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [{
        uri: 'ui://mc/task-list',
        mimeType: RESOURCE_MIME_TYPE,
        text: await loadWidgetHtml('task-list.html'),
        _meta: { ui: { prefersBorder: false } },
      }]
    })
  );

  const mcOrigin = new URL(MC_PUBLIC_URL).origin;

  registerAppResource(
    server,
    'triage-summary-widget',
    TRIAGE_SUMMARY_RESOURCE_URI,
    {
      description: 'Interactive triage search summary widget',
      _meta: {
        ui: {
          csp: { resourceDomains: [mcOrigin] },
          prefersBorder: false,
        },
      },
    },
    async () => {
      const text = await loadWidgetHtml('triage-summary.html');

      return {
        contents: [{
          uri: TRIAGE_SUMMARY_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text,
          _meta: {
            ui: {
              csp: { resourceDomains: [mcOrigin] },
              prefersBorder: false,
            },
          },
        }],
      };
    },
  );
}
