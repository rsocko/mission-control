export type HealthIndicatorTone = 'healthy' | 'warning' | 'critical' | 'neutral';

interface HealthIndicatorData {
  overall: 'healthy' | 'attention' | 'informational';
  database?: {
    status: 'healthy' | 'degraded' | 'critical' | 'error';
  };
  connectors?: Array<{
    status: string;
  }>;
  runtime?: {
    degradations?: string[];
  };
}

export function getHealthIndicatorTone(
  health: HealthIndicatorData | null,
): HealthIndicatorTone {
  if (!health) return 'neutral';

  const critical = health.database?.status === 'critical'
    || health.database?.status === 'error'
    || health.connectors?.some((connector) => connector.status === 'error')
    || health.runtime?.degradations?.some((reason) => reason.startsWith('critical:'));
  if (critical) return 'critical';
  if (health.overall === 'healthy') return 'healthy';
  if (health.overall === 'informational') return 'neutral';

  return 'warning';
}
