import 'server-only';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { requireOperationalUtilityPersistence } from '@/db/persistence/worker-repositories';
import { resetDemoDatabase } from '@/lib/seed-api';
import { updateSettings } from '@/lib/mode';

interface PublicDemoRuntimeDependencies {
  initializeDatabase(): void | Promise<void>;
  resetDemoDatabase(): Promise<void>;
  markSeeded(timestamp: string): void | Promise<void>;
}

async function publicDemoPersistence() {
  return requireOperationalUtilityPersistence(await getWorkerPersistenceRepositories())
    .publicDemo;
}

const defaultDependencies: PublicDemoRuntimeDependencies = {
  async initializeDatabase() {
    await (await publicDemoPersistence()).ensureReady();
  },
  resetDemoDatabase,
  async markSeeded(timestamp) {
    await (await publicDemoPersistence()).markSeeded(timestamp);
    updateSettings({ mode: 'demo', demoSeededAt: timestamp });
  },
};

export async function initializePublicDemoData(
  dependencies: PublicDemoRuntimeDependencies = defaultDependencies,
): Promise<void> {
  await dependencies.initializeDatabase();
  await dependencies.resetDemoDatabase();
  await dependencies.markSeeded(new Date().toISOString());
}
