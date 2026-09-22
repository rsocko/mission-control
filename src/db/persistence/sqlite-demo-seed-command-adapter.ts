import type { DemoSeedCommandService } from '@/lib/settings/mode-route-services';
import { clearDatabase, resetDemoDatabase } from '@/lib/seed-api';
import { clearTriageSampleData } from '@/lib/triage/lifecycle';

/**
 * SQLite-only implementation of the `DemoSeedCommandService` neutral
 * contract (see `@/lib/settings/mode-route-services`), wiring the existing
 * `@/lib/seed-api` and `@/lib/triage/lifecycle` demo/seed functions.
 *
 * This file's name deliberately contains "sqlite" so the PostgreSQL startup
 * graph ratchet (`tests/architecture/final-worker-persistence-boundary.test.ts`)
 * recognizes it as a guarded SQLite-only import and does not traverse into
 * it — the same convention already used by `./sqlite-core-repositories`,
 * `./sqlite-relative-reminder-timezone-repository`, etc. `src/db/runtime.ts`
 * dynamically imports only this module (never `@/lib/seed-api` or
 * `@/lib/triage/lifecycle` directly) on its SQLite branch, so those two
 * SQLite-only modules — and the `@/db`/`@/db/schema` subtree they still
 * statically import — never become reachable from the PostgreSQL startup
 * graph.
 */
export function createSqliteDemoSeedCommandService(): DemoSeedCommandService {
  return { clearDatabase, resetDemoDatabase, clearTriageSampleData };
}
