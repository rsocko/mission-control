import { z } from 'zod';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

const feedbackItemSchema = z.object({
  surface: z.enum(['quick-add', 'ai-insights']),
  action: z.enum(['shown', 'applied', 'dismissed']),
  taskId: z.string().min(1).max(200),
  suggestedTagIds: z.array(z.string().min(1).max(200)).max(20),
  acceptedTagIds: z.array(z.string().min(1).max(200)).max(20),
  removedTagIds: z.array(z.string().min(1).max(200)).max(20),
});
const feedbackSchema = z.union([
  feedbackItemSchema,
  z.array(feedbackItemSchema).min(1).max(50),
]);

export async function POST(request: Request) {
  const result = feedbackSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return ApiErrors.badRequest('Invalid tag suggestion feedback');
  }

  const feedbackItems = Array.isArray(result.data) ? result.data : [result.data];
  feedbackItems.forEach((feedback) => {
    aiLogger.info({
      event: 'tag-recommendation-feedback',
      ...feedback,
    }, 'Tag recommendation feedback');
  });
  return Response.json({ recorded: feedbackItems.length });
}
