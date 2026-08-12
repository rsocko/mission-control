import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { registerWidgetResources } from '@/mcp/widgets';
import { TRIAGE_SUMMARY_RESOURCE_URI } from '@/lib/triage/summary-contract';

describe('MCP Apps resources', () => {
  it('registers the triage summary resource and self-contained asset', async () => {
    const resources: Array<{
      name: string;
      uri: string;
      metadata: Record<string, unknown>;
      callback: () => Promise<{
        contents: Array<{
          uri: string;
          mimeType: string;
          text: string;
          _meta?: Record<string, unknown>;
        }>;
      }>;
    }> = [];
    const captureResource = (
      name: string,
      uri: string,
      metadata: Record<string, unknown>,
      callback: (typeof resources)[number]['callback'],
    ) => resources.push({ name, uri, metadata, callback });
    const server = {
      resource: vi.fn(captureResource),
      registerResource: vi.fn(captureResource),
    };

    registerWidgetResources(server as never);

    expect(resources.map(resource => resource.uri)).toEqual([
      'ui://mc/task-card',
      'ui://mc/task-list',
      TRIAGE_SUMMARY_RESOURCE_URI,
    ]);
    for (const resource of resources) {
      expect(resource.metadata).toMatchObject({
        mimeType: 'text/html;profile=mcp-app',
        _meta: { ui: { prefersBorder: false } },
      });
      const result = await resource.callback();
      expect(result.contents[0]).toMatchObject({
        uri: resource.uri,
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('<!DOCTYPE html>'),
      });
      expect(result.contents[0].text).not.toContain('http-equiv="refresh"');
    }
    const triageResource = resources.find(resource => resource.uri === TRIAGE_SUMMARY_RESOURCE_URI)!;
    expect(triageResource.metadata).toMatchObject({
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          csp: { resourceDomains: [expect.stringMatching(/^https?:\/\//)] },
          prefersBorder: false,
        },
      },
    });
    await expect(triageResource.callback()).resolves.toMatchObject({
      contents: [{
        uri: TRIAGE_SUMMARY_RESOURCE_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('ui/initialize'),
        _meta: {
          ui: {
            csp: { resourceDomains: [expect.stringMatching(/^https?:\/\//)] },
            prefersBorder: false,
          },
        },
      }],
    });

    const asset = fs.readFileSync(
      path.resolve(process.cwd(), 'public/mcp-widgets/triage-summary.html'),
      'utf8',
    );
    expect(asset).toContain('<style>');
    expect(asset).toContain('<script>');
    expect(asset).not.toMatch(/<script[^>]+src=/);
  });
});
