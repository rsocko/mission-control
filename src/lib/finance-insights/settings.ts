import 'server-only';

import type { ConnectorConfig } from '@/types';
import { currencySchema } from './contract';

export function resolveFinanceInsightCurrency(
  config: Pick<ConnectorConfig, 'settings'>,
): string | null {
  const settings = config.settings as Record<string, unknown> | undefined;
  const parsed = currencySchema.safeParse(settings?.householdCurrency);
  return parsed.success ? parsed.data : null;
}
