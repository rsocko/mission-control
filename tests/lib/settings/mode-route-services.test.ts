import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetModeRouteServicesForTests,
  getDemoSeedCommandService,
  getRelativeReminderTimezoneRepository,
  registerDemoSeedCommandService,
  registerRelativeReminderTimezoneRepository,
} from '@/lib/settings/mode-route-services';

/**
 * Unit coverage for the pure backend-neutral registry that
 * `src/app/api/settings/mode/route.ts` depends on (Layer L02). This module
 * has no `@/db`/SQLite/PostgreSQL import edges of its own -- these tests
 * only exercise the plain register/get semantics; the actual SQLite and
 * PostgreSQL wiring is covered separately where those adapters are
 * constructed (`src/db/runtime.ts`'s `initializeRuntimeDatabase`).
 */
describe('mode-route-services registry', () => {
  afterEach(() => {
    _resetModeRouteServicesForTests();
  });

  describe('DemoSeedCommandService', () => {
    it('throws a clear error before any implementation has been registered', () => {
      expect(() => getDemoSeedCommandService()).toThrow(
        'Demo seed command service has not been registered',
      );
    });

    it('returns the exact registered implementation', async () => {
      const service = {
        resetDemoDatabase: async () => {},
        clearDatabase: async () => {},
        clearTriageSampleData: async () => 3,
      };
      registerDemoSeedCommandService(service);
      expect(getDemoSeedCommandService()).toBe(service);
      await expect(getDemoSeedCommandService().clearTriageSampleData()).resolves.toBe(3);
    });

    it('allows re-registration to overwrite a previous implementation', () => {
      const first = {
        resetDemoDatabase: async () => {},
        clearDatabase: async () => {},
        clearTriageSampleData: async () => 0,
      };
      const second = {
        resetDemoDatabase: async () => {},
        clearDatabase: async () => {},
        clearTriageSampleData: async () => 1,
      };
      registerDemoSeedCommandService(first);
      registerDemoSeedCommandService(second);
      expect(getDemoSeedCommandService()).toBe(second);
    });
  });

  describe('RelativeReminderTimezoneRepository', () => {
    it('throws a clear error before any implementation has been registered', () => {
      expect(() => getRelativeReminderTimezoneRepository()).toThrow(
        'Relative reminder timezone repository has not been registered',
      );
    });

    it('returns the exact registered implementation', () => {
      const repository = {
        applyTimezoneRecompute: async () => ({ invalidCount: 0 }),
      };
      registerRelativeReminderTimezoneRepository(repository);
      expect(getRelativeReminderTimezoneRepository()).toBe(repository);
    });
  });
});
