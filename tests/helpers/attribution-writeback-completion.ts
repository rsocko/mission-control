import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/** Local mutation tests model an acknowledged remote receipt; HTTP recovery has its own integration suite. */
export async function completeTestAttributionWritebacks(connectorId: string,
  options: { idempotencyKey?: string } = {}) {
  const { attribution } = (await getWorkerPersistenceRepositories()).finance;
  for (const entry of await attribution.readWritebacks(connectorId, options.idempotencyKey)) {
    await attribution.finishWriteback({
      id: entry.id, status: 'succeeded', errorCode: null, now: new Date().toISOString(),
    });
  }
}
