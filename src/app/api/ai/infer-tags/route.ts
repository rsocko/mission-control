import { inferTags } from '@/lib/ai/features/tag-inference';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { resolveTaskEditPoliciesByIds } from '@/lib/tasks/edit-policy';

export async function GET() {
  try {
    const result = await inferTags();
    const policies = await resolveTaskEditPoliciesByIds(result.suggestions.map((suggestion) => suggestion.taskId));
    return Response.json({
      ...result,
      suggestions: result.suggestions.map((suggestion) => ({
        ...suggestion,
        editPolicy: policies.get(suggestion.taskId),
      })),
    });
  } catch (error) {
    aiLogger.error({ err: error }, 'Tag inference request failed');
    return ApiErrors.internal('Failed', error);
  }
}
