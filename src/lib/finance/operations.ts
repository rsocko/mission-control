import 'server-only';

import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { resolveFinanceExternalLinks } from './external-links';

export async function getFinanceOperationsOverview(requestedConnectorId?: string | null) {
  const overview = await (
    await getWorkerPersistenceRepositories()
  ).finance.web.readOperationsOverview(requestedConnectorId);
  return overview ? { ...overview, links: resolveFinanceExternalLinks() } : null;
}
