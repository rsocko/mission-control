import type { ExternalAgentControlPersistence } from '@/db/persistence/external-agent-control';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export async function getExternalAgentControlPersistence(): Promise<
  ExternalAgentControlPersistence
> {
  return (await getWorkerPersistenceRepositories()).externalAgentControl;
}
