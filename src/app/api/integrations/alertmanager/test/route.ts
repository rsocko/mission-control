import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  getAlertmanagerControl,
  getAlertmanagerIntegrationId,
  isAlertmanagerConfigured,
  recordAlertmanagerIntegrationEvent,
  runSyntheticAlertmanagerLifecycle,
} from '@/lib/alertmanager/operations';
import logger from '@/lib/logger';

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return ApiErrors.unauthorized();
  const integration = getAlertmanagerIntegrationId();

  if (!isAlertmanagerConfigured()) {
    return ApiErrors.conflict('Alertmanager intake is not configured');
  }
  if ((await getAlertmanagerControl()).paused) {
    return ApiErrors.conflict('Resume Alertmanager intake before running a synthetic test');
  }

  try {
    const result = await runSyntheticAlertmanagerLifecycle(integration);
    await recordAlertmanagerIntegrationEvent({
      integration,
      kind: 'synthetic_test',
      outcome: 'passed',
      authenticated: true,
      httpStatus: 200,
      detail: 'Firing, duplicate firing, and resolved lifecycle passed',
    });
    return Response.json(result);
  } catch (error) {
    logger.error({ err: error, integration }, 'Synthetic Alertmanager lifecycle test failed');
    try {
      await recordAlertmanagerIntegrationEvent({
        integration,
        kind: 'synthetic_test',
        outcome: 'failed',
        authenticated: true,
        httpStatus: 500,
        detail: error instanceof Error ? error.message : 'Synthetic lifecycle failed',
      });
    } catch (auditError) {
      logger.error({ err: auditError, integration }, 'Failed to record synthetic Alertmanager test');
    }
    return ApiErrors.internal('Synthetic Alertmanager lifecycle test failed', error);
  }
}
