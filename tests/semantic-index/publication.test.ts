import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: true,
  upsert: vi.fn(async () => ({ status: 'published' as const })),
  delete: vi.fn(async () => ({ status: 'published' as const })),
}));

vi.mock('@/lib/semantic-index/config', () => ({
  isSemanticIndexEnabled: () => mocks.enabled,
}));

vi.mock('@/lib/semantic-index/runtime', () => ({
  publishSemanticUpsert: mocks.upsert,
  publishSemanticDelete: mocks.delete,
}));

describe('semantic entity publication', () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.upsert.mockClear();
    mocks.delete.mockClear();
  });

  it('forwards typed upserts and deletes to the durable runtime publisher', async () => {
    const {
      publishSemanticEntityDelete,
      publishSemanticEntityUpsert,
    } = await import('@/lib/semantic-index/publication');

    await publishSemanticEntityUpsert('project', 'project-1');
    await publishSemanticEntityDelete('triage-item', 'triage-1');

    expect(mocks.upsert).toHaveBeenCalledWith('project', 'project-1');
    expect(mocks.delete).toHaveBeenCalledWith('triage-item', 'triage-1');
  });

  it('does not load or call the runtime publisher when semantic search is disabled', async () => {
    mocks.enabled = false;
    const { publishSemanticEntityUpsert } =
      await import('@/lib/semantic-index/publication');

    await publishSemanticEntityUpsert('tag', 'tag-1');

    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
