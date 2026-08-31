import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCaptureBatch = vi.fn();
const mockEnrich = vi.fn();

vi.mock('@/db', () => {
  throw new Error('SQLite must not load during portable triage import capture');
});

vi.mock('@/lib/triage/persistence', () => ({
  getTriagePersistenceRepositories: () => ({
    capture: {
      captureBatch: mockCaptureBatch,
      enrich: mockEnrich,
    },
  }),
}));

vi.mock('@/lib/triage/embed-resolver', () => ({
  resolveEmbed: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock('@/lib/semantic-index/publication', () => ({
  publishSemanticEntityUpsert: vi.fn().mockResolvedValue(undefined),
}));

describe('portable triage import capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureBatch.mockImplementation(async (items) => (
      items.map((item: object) => ({ status: 'imported', item }))
    ));
  });

  it('loads and persists through the registered repository without SQLite', async () => {
    const { ingestTriageImports } = await import('@/lib/triage/import-capture');

    const results = await ingestTriageImports([{
      sourcePlatform: 'github',
      sourceId: 'github:repo:portable',
      sourceUrl: 'https://github.com/example/portable',
      title: 'Portable repository',
    }]);

    expect(results).toMatchObject([{ status: 'imported' }]);
    expect(mockCaptureBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sourcePlatform: 'github',
        sourceId: 'github:repo:portable',
        contentType: 'repo',
      }),
    ]);
  });
});
