import { tool } from 'ai';
import { z } from 'zod';

export const houstonMemoryTools = {
  recall_houston_memory: tool({
    description: 'Search privacy-minimized summaries of prior Houston conversations. Read-only; returns an explicit availability state.',
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(8).optional(),
    }).strict(),
    execute: async ({ query, limit }) => {
      const { retrieveHoustonMemories } = await import('@/lib/houston-memory/retrieval');
      return retrieveHoustonMemories({ query, limit });
    },
  }),
};
