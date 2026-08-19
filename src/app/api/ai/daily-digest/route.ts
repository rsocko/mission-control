import { generateDailyDigest } from '@/lib/ai/features/daily-digest';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

export async function GET() {
  try {
    const result = await generateDailyDigest();
    return Response.json({ ...result, generatedAt: new Date().toISOString() });
  } catch (error) {
    aiLogger.error({ err: error }, 'Daily digest request failed');
    return ApiErrors.internal('Failed', error);
  }
}
