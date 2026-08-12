import { suggestMicroStatuses } from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

export async function GET() {
  try {
    const result = await suggestMicroStatuses();
    return Response.json(result);
  } catch (error) {
    aiLogger.error({ err: error }, 'Micro-status suggestion request failed');
    return ApiErrors.internal('Failed', error);
  }
}
