import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import {
  resetModulesPreservingProcessRuntimeRegistries,
  resetProcessRuntimeRegistries,
} from '../helpers/process-runtime-registries';

function createWorkerRepositories(): WorkerPersistenceRepositories {
  return {
    connectors: {
      get: vi.fn(async () => null),
      listEnabled: vi.fn(async () => []),
      upsert: vi.fn(async (connector) => connector),
      updateCredentials: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
      mergeSettings: vi.fn(async (_id, settings, patch) => ({ ...settings, ...patch })),
      patchSettingsState: vi.fn(async (_id, key, patch) => ({
        settings: { [key]: patch },
        state: patch,
      })),
    },
    syncRuns: {
      listLatestSuccessfulPulls: vi.fn(async () => []),
      append: vi.fn(async () => undefined),
    },
    execution: {} as WorkerPersistenceRepositories['execution'],
    github: {
      identity: {},
      writeFence: {},
      dependencies: {},
      hierarchy: {},
      projects: {},
    } as WorkerPersistenceRepositories['github'],
    connectorState: {
      workTodo: {},
    } as WorkerPersistenceRepositories['connectorState'],
    notificationDelivery: {} as WorkerPersistenceRepositories['notificationDelivery'],
    reminders: {} as WorkerPersistenceRepositories['reminders'],
    triage: {} as WorkerPersistenceRepositories['triage'],
    planningSignals: {} as WorkerPersistenceRepositories['planningSignals'],
    projectAutomation: {} as WorkerPersistenceRepositories['projectAutomation'],
    eventDelivery: {
      subscriptions: {},
      outbox: {},
    } as WorkerPersistenceRepositories['eventDelivery'],
    notificationEntityLinking:
      {} as WorkerPersistenceRepositories['notificationEntityLinking'],
    notificationEnrichment: {} as WorkerPersistenceRepositories['notificationEnrichment'],
    externalAgentControl: {} as WorkerPersistenceRepositories['externalAgentControl'],
    finance: {
      identity: {},
      snapshots: {},
      datasets: {},
      attribution: {},
      insights: {
        connectors: {},
        projection: {},
        backfill: {},
        publication: {},
        delivery: {},
        occurrenceCache: {},
        notifications: {},
      },
      attention: {
        routing: {},
        repair: {},
      },
    } as WorkerPersistenceRepositories['finance'],
  };
}

afterEach(() => {
  resetProcessRuntimeRegistries();
  resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
});

describe('worker persistence runtime', () => {
  it('fails closed before composition without evaluating SQLite', async () => {
    const databaseModule = vi.fn(() => {
      throw new Error('SQLite must not be evaluated');
    });
    vi.doMock('@/db', databaseModule);

    const runtime = await import('@/lib/persistence/worker-runtime');

    await expect(runtime.getWorkerPersistenceRepositories()).rejects.toThrow(
      'Worker persistence repositories must be registered before worker persistence is accessed',
    );
    expect(databaseModule).not.toHaveBeenCalled();
  });

  it('allows pre-access replacement and fences the selected composition after access', async () => {
    const runtime = await import('@/lib/persistence/worker-runtime');
    const provisional = createWorkerRepositories();
    const selected = createWorkerRepositories();

    runtime.registerWorkerPersistenceRepositories(provisional);
    runtime.registerWorkerPersistenceRepositories(selected);

    const [first, second] = await Promise.all([
      runtime.getWorkerPersistenceRepositories(),
      runtime.getWorkerPersistenceRepositories(),
    ]);
    expect(first).toBe(selected);
    expect(second).toBe(selected);
    expect(() => runtime.registerWorkerPersistenceRepositories(selected)).not.toThrow();
    expect(() => runtime.registerWorkerPersistenceRepositories(createWorkerRepositories()))
      .toThrow('Worker persistence repositories are already selected');
  });

  it('shares the selected composition across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/persistence/worker-runtime');
    const selected = createWorkerRepositories();
    firstRuntime.registerWorkerPersistenceRepositories(selected);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondRuntime = await import('@/lib/persistence/worker-runtime');

    await expect(secondRuntime.getWorkerPersistenceRepositories()).resolves.toBe(selected);
    secondRuntime.clearWorkerPersistenceRepositories(selected);
  });

  it('borrows an accessed triage identity without taking cleanup ownership', async () => {
    const runtime = await import('@/lib/persistence/worker-runtime');
    const triageRuntime = await import('@/lib/triage/persistence');
    const selectedTriage = createWorkerRepositories().triage;
    const generated = createWorkerRepositories();
    const composed = { ...generated, triage: selectedTriage };

    triageRuntime.registerTriagePersistenceRepositories(selectedTriage);
    expect(triageRuntime.getTriagePersistenceRepositories()).toBe(selectedTriage);
    runtime.registerWorkerPersistenceRepositoriesWithBorrowedTriage(composed);
    expect(await runtime.getWorkerPersistenceRepositories()).toBe(composed);

    runtime.clearWorkerPersistenceRepositories(generated);
    expect(await runtime.getWorkerPersistenceRepositories()).toBe(composed);
    runtime.clearWorkerPersistenceRepositories(composed);
    expect(triageRuntime.getTriagePersistenceRepositories()).toBe(selectedTriage);
    triageRuntime.clearTriagePersistenceRepositories(selectedTriage);
  });
});
