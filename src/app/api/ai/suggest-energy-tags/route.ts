import { suggestEnergyTags } from '@/lib/ai/features/energy-tag-suggestions';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { getAIDailyPlanningPersistence } from '@/lib/ai/workflow-persistence';
import type { EnergyTagDefinition } from '@/db/persistence/daily-planning';

const ENERGY_TAG_DEFS: readonly EnergyTagDefinition[] = [
  { slug: 'energy-high', name: 'Energy: High', color: '#10b981' },
  { slug: 'energy-medium', name: 'Energy: Medium', color: '#f59e0b' },
  { slug: 'energy-low', name: 'Energy: Low', color: '#ef4444' },
];

/**
 * POST /api/ai/suggest-energy-tags
 * AI infers energy demand for tasks and optionally auto-applies the tags.
 *
 * Body: { taskIds?: string[], autoApply?: boolean }
 * - taskIds: specific tasks to classify (omit for all untagged open tasks)
 * - autoApply: if true, automatically add the energy tags to tasks (default: false)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const taskIds: string[] | undefined = body.taskIds;
    const autoApply = body.autoApply === true;

    const result = await suggestEnergyTags(taskIds);

    if (autoApply && result.suggestions.length > 0) {
      const persistence = await getAIDailyPlanningPersistence();
      await persistence.energySuggestions.apply({
        definitions: ENERGY_TAG_DEFS,
        suggestions: result.suggestions.map((suggestion) => ({
          taskId: suggestion.taskId,
          energyLevel: suggestion.energyLevel,
        })),
        createdAt: new Date().toISOString(),
      });
    }

    return Response.json({
      suggestions: result.suggestions,
      applied: autoApply,
      generatedAt: new Date().toISOString(),
      routing: result.routing,
    });
  } catch (error) {
    aiLogger.error({ err: error }, 'Energy tag inference failed');
    return ApiErrors.internal('Failed', error);
  }
}
