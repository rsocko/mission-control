import { z } from 'zod';
import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  getAlertmanagerIntegrationId,
  getAlertmanagerIntegrationStatus,
  setAlertmanagerPaused,
} from '@/lib/alertmanager/operations';

const updateSchema = z.object({ paused: z.boolean() }).strict();

export async function GET() {
  try {
    return Response.json(await getAlertmanagerIntegrationStatus());
  } catch (error) {
    return ApiErrors.internal('Failed to load Alertmanager integration status', error);
  }
}

export async function PATCH(request: Request) {
  if (!isTrustedMutationRequest(request)) return ApiErrors.unauthorized();
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return ApiErrors.badRequest('paused must be a boolean');

  try {
    const actor = request.headers.has('x-mc-api-key') ? 'API key' : 'Settings';
    const control = await setAlertmanagerPaused(
      getAlertmanagerIntegrationId(),
      parsed.data.paused,
      actor,
    );
    return Response.json({ success: true, ...control });
  } catch (error) {
    return ApiErrors.internal('Failed to update Alertmanager intake state', error);
  }
}
