import { z } from 'zod';
import { ApiErrors } from '@/lib/api-error';
import type { RecurrencePreviewRequest } from '@/lib/recurrence/editor-contract';
import { buildRecurrencePreview } from '@/lib/recurrence/editor';

const previewSchema = z.strictObject({
  recurrence: z.string().trim().min(1).max(500),
  mode: z.enum(['schedule', 'completion']),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable().optional(),
  timezone: z.string().trim().min(1).max(500),
  options: z.strictObject({
    skipDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100),
    catchUp: z.enum(['latest', 'none']),
  }),
  rule: z.unknown().nullable().optional(),
});

export async function POST(request: Request) {
  const parsed = previewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return ApiErrors.badRequest(`Invalid recurrence preview: ${parsed.error.issues[0].message}`);
  }

  return Response.json(buildRecurrencePreview(parsed.data as RecurrencePreviewRequest));
}
