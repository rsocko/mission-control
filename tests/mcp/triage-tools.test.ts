import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

const { mcGet } = vi.hoisted(() => ({
  mcGet: vi.fn(),
}));

vi.mock('@/mcp/client', () => ({ mcGet }));

import { registerTriageTools } from '@/mcp/tools/triage';
import { TRIAGE_SUMMARY_RESOURCE_URI } from '@/lib/triage/summary-contract';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: {
    ui?: {
      resourceUri?: string;
      url?: string;
      data?: Record<string, unknown>;
    };
  };
};

interface ToolRegistration {
  name: string;
  schema: Record<string, ZodType>;
  metadata?: Record<string, unknown>;
  callback: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function registerTools() {
  const registrations: ToolRegistration[] = [];
  const server = {
    registerTool: vi.fn((
      name: string,
      metadata: { inputSchema: Record<string, ZodType> },
      callback: ToolRegistration['callback'],
    ) => registrations.push({
      name,
      schema: metadata.inputSchema,
      metadata,
      callback,
    })),
    tool: vi.fn((
      name: string,
      _description: string,
      schema: Record<string, ZodType>,
      callback: ToolRegistration['callback'],
    ) => registrations.push({ name, schema, callback })),
  };
  registerTriageTools(server as never);
  return registrations;
}

function triageItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'triage-1',
    sourcePlatform: 'github',
    sourceId: 'source-1',
    sourceUrl: 'https://github.com/octo-org/mission-control',
    title: 'Mission Control widgets',
    description: 'Saved repository',
    thumbnailUrl: '/api/assets/thumbnails/widget.png',
    contentType: 'repo',
    capturedAt: '2026-08-05T12:00:00.000Z',
    ingestedAt: '2026-08-05T12:01:00.000Z',
    status: 'pending',
    aiSummary: 'A repository about rich MCP widgets.',
    aiCategories: ['software-development'],
    aiRelevanceScore: 94,
    aiUrgency: 'evergreen',
    aiSuggestedActions: [],
    rawMetadata: {},
    actionsTaken: [],
    ...overrides,
  };
}

function response(items = [triageItem()]) {
  return {
    ok: true,
    status: 200,
    data: {
      items,
      totalFiltered: items.length,
      hasMore: false,
      stats: {
        total: items.length,
        pending: items.length,
        snoozed: 0,
        actioned: 0,
        dismissed: 0,
        sourceCounts: { github: items.length },
      },
    },
  };
}

describe('mc_search_triage widget result', () => {
  beforeEach(() => mcGet.mockReset());

  it('returns readable fallback text, structured data, and triage resource metadata', async () => {
    mcGet.mockResolvedValue(response());
    const registration = registerTools().find(tool => tool.name === 'mc_search_triage')!;

    const result = await registration.callback({ query: 'widgets', limit: 20 });

    expect(registration.metadata).toMatchObject({
      _meta: {
        ui: {
          resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
          visibility: ['model'],
        },
        'ui/resourceUri': TRIAGE_SUMMARY_RESOURCE_URI,
      },
    });
    expect(result.content[0].text).toContain('Found 1 triage items');
    expect(result.content[0].text).toContain('Mission Control widgets');
    expect(result.structuredContent).toMatchObject({
      resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
      total: 1,
      hasMore: false,
      items: [{
        id: 'triage-1',
        source: 'github',
        score: 94,
        thumbnailUrl: expect.stringContaining('/api/assets/thumbnails/widget.png'),
      }],
    });

    expect(result._meta).toMatchObject({
      ui: {
        resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
        url: expect.stringContaining('/mcp-widgets/triage-summary.html'),
        data: result.structuredContent,
      },
    });
  });

  it('bounds generated titles for maximum-length queries', async () => {
    mcGet.mockResolvedValue(response());
    const registration = registerTools().find(tool => tool.name === 'mc_search_triage')!;

    const result = await registration.callback({ query: 'x'.repeat(200) });

    expect((result.structuredContent!.title as string).length).toBeLessThanOrEqual(200);
  });

  it('passes category filters through with pagination metadata intact', async () => {
    mcGet.mockResolvedValue({
      ...response([triageItem({ aiCategories: ['software-development'] })]),
      data: {
        ...response().data,
        totalFiltered: 6,
        hasMore: true,
      },
    });
    const registration = registerTools().find(tool => tool.name === 'mc_search_triage')!;

    const result = await registration.callback({
      categories: ['software-development', 'ux'],
      limit: 1,
      offset: 2,
    });

    const requestUrl = new URL(mcGet.mock.calls[0][0], 'https://mc.example');
    expect(requestUrl.searchParams.getAll('category')).toEqual(['software-development', 'ux']);
    expect(requestUrl.searchParams.get('limit')).toBe('1');
    expect(requestUrl.searchParams.get('offset')).toBe('2');
    expect(result.structuredContent).toMatchObject({
      total: 6,
      hasMore: true,
    });
  });

  it('emits a valid empty widget state and removes unsafe URLs', async () => {
    mcGet
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([triageItem({
        sourceUrl: 'javascript:alert(1)',
        thumbnailUrl: 'data:image/svg+xml,<svg onload=alert(1)>',
      })]));
    const registration = registerTools().find(tool => tool.name === 'mc_search_triage')!;

    const empty = await registration.callback({});
    expect(empty.structuredContent).toMatchObject({ total: 0, items: [] });

    const unsafe = await registration.callback({});
    const [item] = unsafe.structuredContent!.items as Array<Record<string, unknown>>;
    expect(item).not.toHaveProperty('url');
    expect(item).not.toHaveProperty('thumbnailUrl');
    expect(unsafe.content[0].text).not.toContain('javascript:');
  });

  it('preserves the MCP error contract', async () => {
    mcGet.mockResolvedValue({ ok: false, status: 503, error: 'Triage unavailable' });
    const registration = registerTools().find(tool => tool.name === 'mc_search_triage')!;

    const result = await registration.callback({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Triage unavailable');
    expect(result._meta).toBeUndefined();
  });
});
