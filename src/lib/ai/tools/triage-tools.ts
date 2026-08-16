import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { listTriageItems } from '@/lib/triage/query';
import { buildTriageSummaryData } from '@/lib/triage/summary-contract';

const sourceSchema = z.enum([
  'all',
  'reddit',
  'instagram',
  'youtube',
  'github',
  'twitter',
  'facebook',
  'tiktok',
  'pinterest',
  'document-intelligence',
  'scout',
  'browser_extension',
  'browser_tabs',
  'ios_share',
  'android_share',
  'web',
]);

export const triageTools = {
  searchTriage: tool({
    description: 'Search saved items in the Mission Control triage queue and return a bounded summary.',
    inputSchema: zodSchema(z.object({
      query: z.string().trim().max(200).optional(),
      source: sourceSchema.optional().default('all'),
      status: z.enum(['all', 'pending', 'snoozed', 'actioned', 'dismissed']).optional().default('all'),
      sortBy: z.enum(['relevance', 'newest', 'oldest', 'score']).optional().default('relevance'),
      limit: z.number().int().min(1).max(50).optional().default(20),
    }).strict()),
    execute: async ({ query, source, status, sortBy, limit }) => {
      const result = await listTriageItems({
        q: query,
        source,
        status,
        sortBy,
        limit,
      });

      return buildTriageSummaryData({
        items: result.items,
        total: result.totalFiltered,
        hasMore: result.hasMore,
        title: query ? `Triage results for "${query}"` : 'Triage summary',
      });
    },
  }),
};
