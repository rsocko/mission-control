import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TriagePersistenceRepositories } from '@/db/persistence/triage-repositories';
import type { ConnectorRuntimeRegistry } from '@/lib/connectors/registry-runtime';
import type { LegacySearchIndexingService } from '@/lib/search/indexing-service';
import type { KeywordSearchRepository } from '@/lib/search/repository';
import { resetProcessRuntimeRegistries } from '../helpers/process-runtime-registries';

afterEach(() => {
  resetProcessRuntimeRegistries();
  vi.resetModules();
});

describe('process-wide runtime registries', () => {
  it('shares lifecycle fencing across isolated module evaluations', async () => {
    const firstLifecycle = await import('@/lib/persistence/composition-lifecycle');
    firstLifecycle.blockPersistenceComposition();

    vi.resetModules();
    const secondLifecycle = await import('@/lib/persistence/composition-lifecycle');

    expect(() => secondLifecycle.assertPersistenceCompositionAccessAllowed())
      .toThrow('Persistence composition is unavailable');
    expect(() => secondLifecycle.assertPersistenceCompositionPublicationAllowed())
      .toThrow('Persistence composition publication is blocked');
  });

  it('shares triage registration across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/triage/persistence');
    const selected = { marker: 'triage' } as unknown as TriagePersistenceRepositories;
    firstRuntime.registerTriagePersistenceRepositories(selected);

    vi.resetModules();
    const secondRuntime = await import('@/lib/triage/persistence');

    expect(secondRuntime.getTriagePersistenceRepositories()).toBe(selected);
    secondRuntime.clearTriagePersistenceRepositories(selected);
  });

  it('shares connector registration across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/connectors/registry-runtime');
    const selected: ConnectorRuntimeRegistry = {
      createConnector: vi.fn(),
      replaceConnector: vi.fn(),
      getConnector: vi.fn(),
      getAllConnectors: vi.fn(() => []),
    };
    firstRuntime.registerConnectorRegistry(selected);

    vi.resetModules();
    const secondRuntime = await import('@/lib/connectors/registry-runtime');

    expect(secondRuntime.getConnectorRegistry()).toBe(selected);
  });

  it('shares search, enrichment, and publication services across module evaluations', async () => {
    const firstSearch = await import('@/lib/search/keyword-runtime');
    const firstEnrichment = await import(
      '@/lib/notifications/enrichment/ai-enrichment-service'
    );
    const firstPublication = await import('@/lib/semantic-index/publication-service');
    const keywordRepository: KeywordSearchRepository = {
      rebuild: vi.fn(),
      indexTask: vi.fn(),
      removeTask: vi.fn(),
      indexNotification: vi.fn(),
      removeNotification: vi.fn(),
      warmUp: vi.fn(),
      search: vi.fn(),
    };
    const enrich = vi.fn(async () => null);
    const upsert = vi.fn(async () => undefined);
    firstSearch.registerKeywordSearchRepository(keywordRepository);
    firstEnrichment.registerAIEnrichmentService({ enrich });
    firstPublication.registerSemanticPublicationService({
      upsert,
      delete: vi.fn(async () => undefined),
    });

    vi.resetModules();
    const secondSearch = await import('@/lib/search/keyword-runtime');
    const secondEnrichment = await import(
      '@/lib/notifications/enrichment/ai-enrichment-service'
    );
    const secondPublication = await import('@/lib/semantic-index/publication-service');

    expect(secondSearch.getKeywordSearchRepository()).toBe(keywordRepository);
    await secondEnrichment.enrichWithAI({
      notificationId: 'notification-1',
      title: 'Notification',
      body: null,
      connectorType: 'local',
      category: 'tasks',
      metadata: {},
      presentation: {},
    });
    await secondPublication.publishSemanticEntityUpsert('task', 'task-1');
    expect(enrich).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith('task', 'task-1');
  });

  it('shares mode route services across isolated module evaluations', async () => {
    const firstRuntime = await import('@/lib/settings/mode-route-services');
    const demoService = {
      resetDemoDatabase: vi.fn(async () => undefined),
      clearDatabase: vi.fn(async () => undefined),
      clearTriageSampleData: vi.fn(async () => 0),
    };
    const timezoneRepository = {
      applyTimezoneRecompute: vi.fn(async () => ({ invalidCount: 0 })),
    };
    firstRuntime.registerDemoSeedCommandService(demoService);
    firstRuntime.registerRelativeReminderTimezoneRepository(timezoneRepository);

    vi.resetModules();
    const secondRuntime = await import('@/lib/settings/mode-route-services');

    expect(secondRuntime.getDemoSeedCommandService()).toBe(demoService);
    expect(secondRuntime.getRelativeReminderTimezoneRepository()).toBe(timezoneRepository);
  });

  it('shares legacy search indexing across isolated module evaluations', async () => {
    const firstIndexing = await import('@/lib/search/indexing-service');
    const indexingService = {
      warmUp: vi.fn(),
      indexTask: vi.fn(),
      removeTask: vi.fn(),
      indexAlert: vi.fn(),
    } satisfies LegacySearchIndexingService;
    firstIndexing.registerLegacySearchIndexingService(indexingService);

    vi.resetModules();
    const secondIndexing = await import('@/lib/search/indexing-service');

    expect(secondIndexing.getLegacySearchIndexingService()).toBe(indexingService);
  });
});
