import type Database from 'better-sqlite3';
import type {
  DatabaseHealthProbe,
  DatabaseHealthProbeResult,
} from './database-health-probe';

type WithoutObservation = <T>(callback: () => T) => T;

export class SqliteDatabaseHealthProbe implements DatabaseHealthProbe {
  constructor(
    private readonly database: Database.Database,
    private readonly withoutObservation: WithoutObservation,
  ) {}

  async inspect(): Promise<DatabaseHealthProbeResult> {
    return this.withoutObservation(() => {
      const result = this.database.prepare('SELECT 1 as ok').get() as
        | { ok: number }
        | undefined;
      const pageCount = this.database.prepare('PRAGMA page_count').get() as
        | { page_count: number }
        | undefined;
      const pageSize = this.database.prepare('PRAGMA page_size').get() as
        | { page_size: number }
        | undefined;
      return result?.ok === 1
        ? {
            connected: true,
            severity: 'healthy',
            message: 'Connected',
            sizeBytes: (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 0),
            backend: {
              kind: 'sqlite',
              details: {
                pageCount: pageCount?.page_count ?? 0,
                pageSize: pageSize?.page_size ?? 0,
              },
            },
          }
        : {
            connected: false,
            severity: 'error',
            message: 'Query returned unexpected result',
            backend: { kind: 'sqlite' },
          };
    });
  }

  async hasSeedMarker(): Promise<boolean> {
    return this.withoutObservation(() => Boolean(
      this.database
        .prepare("SELECT seeded_at FROM public_demo_runtime WHERE id = 'seed'")
        .get(),
    ));
  }
}
