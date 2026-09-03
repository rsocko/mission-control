/**
 * Backend-neutral service registries consumed exclusively by
 * `src/app/api/settings/mode/route.ts` (Layer L02; see
 * `docs/architecture/persistence-boundaries.md`, "Web/API PostgreSQL parity:
 * Layer L02").
 *
 * This module deliberately has ZERO import edges — static or dynamic — to
 * `@/db`, `@/lib/seed-api`, `@/lib/triage/lifecycle`, or any other
 * SQLite/PostgreSQL-touching module. It only declares interfaces (the
 * `RelativeReminderTimezoneRepository` import below is `import type`, which
 * is erased at build time and does not create a module dependency) plus a
 * plain in-memory registry (register/get pair per service). This lets the
 * route depend on it without inheriting any backend taint, so the route
 * module itself is neither Tier A (import-time failure under PostgreSQL) nor
 * Tier B (call-time-only failure) in the web-persistence-graph census.
 *
 * The concrete SQLite and PostgreSQL implementations are constructed and
 * registered once, at server startup, by `initializeRuntimeDatabase()` in
 * `src/db/runtime.ts` — the single, already-established composition root
 * used for both backends (it already does the equivalent registration for
 * `CorePersistenceRepositories` via `registerCorePersistenceRepositories`).
 * That function is invoked from `src/instrumentation.ts` before the server
 * accepts any request, so by the time a route handler runs, both services
 * below are guaranteed to be registered.
 */
import type { RelativeReminderTimezoneRepository } from '@/db/persistence/relative-reminder-timezone';

/**
 * The three demo/seed-only commands reachable from `POST
 * /api/settings/mode`. There is no PostgreSQL equivalent for these yet: the
 * PostgreSQL registration rejects all three with the documented
 * "SQLite-only" error, before any SQLite-side module is evaluated.
 */
export interface DemoSeedCommandService {
  resetDemoDatabase(): Promise<void>;
  clearDatabase(): Promise<void>;
  clearTriageSampleData(): Promise<number>;
}

let demoSeedCommandService: DemoSeedCommandService | null = null;

export function registerDemoSeedCommandService(service: DemoSeedCommandService): void {
  demoSeedCommandService = service;
}

export function getDemoSeedCommandService(): DemoSeedCommandService {
  if (!demoSeedCommandService) {
    throw new Error('Demo seed command service has not been registered');
  }
  return demoSeedCommandService;
}

let relativeReminderTimezoneRepository: RelativeReminderTimezoneRepository | null = null;

export function registerRelativeReminderTimezoneRepository(
  repository: RelativeReminderTimezoneRepository,
): void {
  relativeReminderTimezoneRepository = repository;
}

export function getRelativeReminderTimezoneRepository(): RelativeReminderTimezoneRepository {
  if (!relativeReminderTimezoneRepository) {
    throw new Error('Relative reminder timezone repository has not been registered');
  }
  return relativeReminderTimezoneRepository;
}

/** Test-only reset hook so unit tests can exercise registration in isolation. */
export function _resetModeRouteServicesForTests(): void {
  demoSeedCommandService = null;
  relativeReminderTimezoneRepository = null;
}
