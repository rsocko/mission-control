import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import {
  resetModulesPreservingProcessRuntimeRegistries,
  resetProcessRuntimeRegistries,
} from '../helpers/process-runtime-registries';

function createCoreRepositories(): CorePersistenceRepositories {
  return {
    tasks: {} as CorePersistenceRepositories['tasks'],
    projects: {} as CorePersistenceRepositories['projects'],
    connectors: {} as CorePersistenceRepositories['connectors'],
    notifications: {} as CorePersistenceRepositories['notifications'],
    settings: {} as CorePersistenceRepositories['settings'],
    houstonMemories: {} as CorePersistenceRepositories['houstonMemories'],
  };
}

afterEach(() => {
  resetProcessRuntimeRegistries();
  resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
});

describe('core persistence runtime', () => {
  it('shares the selected composition across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/persistence/runtime');
    const selected = createCoreRepositories();
    firstRuntime.registerCorePersistenceRepositories(selected);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondRuntime = await import('@/lib/persistence/runtime');

    expect(secondRuntime.getCorePersistenceRepositories()).toBe(selected);
    secondRuntime.clearCorePersistenceRepositories(selected);
  });

  it('keeps My Day and due-date capability resolution live across bundle evaluation', async () => {
    const firstRuntime = await import('@/lib/persistence/runtime');
    const getConnector = vi.fn(async () => ({
      id: 'todo-1',
      type: 'microsoft-todo',
      enabled: true,
      capabilities: { write: true },
      settings: {},
    }));
    const selected: CorePersistenceRepositories = {
      ...createCoreRepositories(),
      connectors: {
        get: getConnector,
      } as unknown as CorePersistenceRepositories['connectors'],
    };
    firstRuntime.registerCorePersistenceRepositories(selected);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const {
      getConnectorCapabilities,
      isConnectorEnabled,
    } = await import('@/lib/connectors/capabilities');

    await expect(getConnectorCapabilities('todo-1')).resolves.toMatchObject({ write: true });
    await expect(isConnectorEnabled('todo-1')).resolves.toBe(true);
    expect(getConnector).toHaveBeenCalledTimes(2);
  });

  it('keeps replacement fencing process-wide after access', async () => {
    const firstRuntime = await import('@/lib/persistence/runtime');
    const selected = createCoreRepositories();
    firstRuntime.registerCorePersistenceRepositories(selected);
    expect(firstRuntime.getCorePersistenceRepositories()).toBe(selected);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const secondRuntime = await import('@/lib/persistence/runtime');

    expect(() => secondRuntime.registerCorePersistenceRepositories(createCoreRepositories()))
      .toThrow('Core persistence repositories are already selected');
    secondRuntime.clearCorePersistenceRepositories(selected);
  });

  it('does not let stale cleanup clear a newer registration', async () => {
    const runtime = await import('@/lib/persistence/runtime');
    const stale = createCoreRepositories();
    const current = createCoreRepositories();
    runtime.registerCorePersistenceRepositories(stale);
    runtime.registerCorePersistenceRepositories(current);

    runtime.clearCorePersistenceRepositories(stale);

    expect(runtime.getCorePersistenceRepositories()).toBe(current);
    runtime.clearCorePersistenceRepositories(current);
  });

  it('fails closed when the process slot schema is incompatible', async () => {
    const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
    host[Symbol.for('mission-control.core-persistence-registry')] = {
      selected: createCoreRepositories(),
      accessed: false,
    };

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const runtime = await import('@/lib/persistence/runtime');

    expect(() => runtime.getCorePersistenceRepositories()).toThrow(
      'Incompatible process runtime slot: mission-control.core-persistence-registry',
    );
  });
});
