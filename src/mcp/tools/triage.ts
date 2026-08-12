import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { mcGet } from '../client';
import { MC_PUBLIC_URL } from '../public-url';
import {
  buildTriageSummaryData,
  toTriageSummaryItem,
  TRIAGE_SUMMARY_RESOURCE_URI,
} from '@/lib/triage/summary-contract';
import type { TriageItem } from '@/types';

interface TriageListResponse {
  items: TriageItem[];
  totalFiltered: number;
  hasMore: boolean;
  stats: {
    total: number;
    pending: number;
    snoozed: number;
    actioned: number;
    dismissed: number;
    sourceCounts: Record<string, number>;
  };
}

export function registerTriageTools(server: McpServer) {
  registerAppTool(
    server,
    'mc_search_triage',
    {
      description: 'Search the Triage Queue — saved/bookmarked content from Reddit, Instagram, YouTube, GitHub Stars, etc. Supports filtering by source platform, status, text query, and AI-assigned categories.',
      inputSchema: {
        query: z.string().trim().max(200).optional().describe('Text search (matches title, description, URL)'),
        source: z.enum(['all', 'reddit', 'instagram', 'youtube', 'github', 'twitter', 'facebook', 'tiktok', 'pinterest', 'document-intelligence', 'scout', 'browser_extension', 'browser_tabs', 'ios_share', 'android_share', 'web']).optional().describe('Filter by source platform (default: all)'),
        status: z.enum(['all', 'pending', 'snoozed', 'actioned', 'dismissed']).optional().describe('Filter by triage status (default: all)'),
        sortBy: z.enum(['relevance', 'newest', 'oldest', 'score']).optional().describe('Sort order (default: relevance)'),
        limit: z.number().int().min(1).max(500).optional().describe('Max results to return (default 50, max 500)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
        categories: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe('Filter by AI-assigned categories (e.g. ["software-development", "ux"]). Returns items matching ANY of the specified categories.'),
      },
      _meta: {
        ui: {
          resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
          visibility: ['model'],
        },
      },
    },
    async ({ query, source, status, sortBy, limit, offset, categories }) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (source && source !== 'all') params.set('source', source);
      if (status && status !== 'all') params.set('status', status);
      if (sortBy) params.set('sortBy', sortBy);
      categories?.forEach(category => params.append('category', category));
      params.set('limit', String(limit || 50));
      if (offset) params.set('offset', String(offset));

      const res = await mcGet<TriageListResponse>(`/api/triage?${params.toString()}`);

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }

      const items = res.data!.items;
      const stats = res.data!.stats;
      const totalFromApi = res.data!.totalFiltered;
      const header = `Found ${items.length} triage items (${totalFromApi} total matching, ${stats.total} in queue overall)`;

      // Return a compact representation focused on useful fields
      const compact = items.map((item) => {
        const safeItem = toTriageSummaryItem(item);
        return {
          id: safeItem.id,
          title: safeItem.title,
          source: safeItem.source,
          url: safeItem.url,
          contentType: safeItem.contentType,
          status: safeItem.status,
          categories: safeItem.categories,
          summary: safeItem.summary,
          score: safeItem.score,
          capturedAt: safeItem.capturedAt,
        };
      });

      const widgetData = buildTriageSummaryData({
        items,
        total: totalFromApi,
        hasMore: res.data!.hasMore,
        title: query ? `Triage results for "${query}"` : 'Triage summary',
        mcBaseUrl: MC_PUBLIC_URL,
        thumbnailBaseUrl: MC_PUBLIC_URL,
      });

      return {
        content: [{ type: 'text' as const, text: `${header}\n\n${JSON.stringify(compact, null, 2)}` }],
        structuredContent: widgetData,
        _meta: {
          ui: {
            resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
            url: `${MC_PUBLIC_URL}/mcp-widgets/triage-summary.html`,
            title: widgetData.title,
            data: widgetData,
          },
        },
      };
    }
  );

  server.tool(
    'mc_triage_stats',
    'Get aggregate stats about the Triage Queue — total items, breakdown by source platform and status.',
    {},
    async () => {
      const res = await mcGet<TriageListResponse>('/api/triage?limit=1');

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }

      const stats = res.data!.stats;
      const lines = [
        `Triage Queue Stats:`,
        `  Total: ${stats.total}`,
        `  Pending: ${stats.pending}`,
        `  Snoozed: ${stats.snoozed}`,
        `  Actioned: ${stats.actioned}`,
        `  Dismissed: ${stats.dismissed}`,
        ``,
        `By Source:`,
        ...Object.entries(stats.sourceCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([platform, count]) => `  ${platform}: ${count}`),
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );
}
