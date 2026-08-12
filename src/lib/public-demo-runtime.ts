import 'server-only';
import { sqlite } from '@/db';
import { resetDemoDatabase } from '@/lib/seed-api';
import { updateSettings } from '@/lib/mode';

interface PublicDemoRuntimeDependencies {
  initializeDatabase(): void;
  resetDemoDatabase(): Promise<void>;
  markSeeded(timestamp: string): void;
}

const defaultDependencies: PublicDemoRuntimeDependencies = {
  initializeDatabase() {
    sqlite.prepare('SELECT 1').get();
  },
  resetDemoDatabase,
  markSeeded(timestamp) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS public_demo_runtime (
        id TEXT PRIMARY KEY,
        seeded_at TEXT NOT NULL
      )
    `);
    sqlite.prepare(`
      INSERT INTO public_demo_runtime (id, seeded_at)
      VALUES ('seed', ?)
      ON CONFLICT(id) DO UPDATE SET seeded_at = excluded.seeded_at
    `).run(timestamp);
    updateSettings({ mode: 'demo', demoSeededAt: timestamp });
  },
};

export async function initializePublicDemoData(
  dependencies: PublicDemoRuntimeDependencies = defaultDependencies,
): Promise<void> {
  dependencies.initializeDatabase();
  await dependencies.resetDemoDatabase();
  dependencies.markSeeded(new Date().toISOString());
}
