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
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

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

interface ModeRouteServiceRegistry {
  demoSeedCommandService: DemoSeedCommandService | null;
  relativeReminderTimezoneRepository: RelativeReminderTimezoneRepository | null;
}

const REGISTRY_KEY = 'mission-control.mode-route-service-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): ModeRouteServiceRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    demoSeedCommandService: null,
    relativeReminderTimezoneRepository: null,
  }));
}

export function registerDemoSeedCommandService(service: DemoSeedCommandService): void {
  registry().demoSeedCommandService = service;
}

export function getDemoSeedCommandService(): DemoSeedCommandService {
  const { demoSeedCommandService } = registry();
  if (!demoSeedCommandService) {
    throw new Error('Demo seed command service has not been registered');
  }
  return demoSeedCommandService;
}

export function registerRelativeReminderTimezoneRepository(
  repository: RelativeReminderTimezoneRepository,
): void {
  registry().relativeReminderTimezoneRepository = repository;
}

export function getRelativeReminderTimezoneRepository(): RelativeReminderTimezoneRepository {
  const { relativeReminderTimezoneRepository } = registry();
  if (!relativeReminderTimezoneRepository) {
    throw new Error('Relative reminder timezone repository has not been registered');
  }
  return relativeReminderTimezoneRepository;
}

/** Test-only reset hook so unit tests can exercise registration in isolation. */
export function _resetModeRouteServicesForTests(): void {
  const state = registry();
  state.demoSeedCommandService = null;
  state.relativeReminderTimezoneRepository = null;
}
