/**
 * Document Intelligence Importer Tests
 *
 * Covers:
 *  - importDocumentIntelligenceActions: fetch, mapping, dedup
 *  - importAllDocumentIntelligenceActions: sync state persistence
 *  - ALLOWED_SOURCES includes 'document-intelligence'
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(),
      })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  triageSyncState: { id: 'id' },
  triageItems: {
    id: 'id',
    sourcePlatform: 'source_platform',
    sourceId: 'source_id',
    sourceUrl: 'source_url',
    canonicalUrl: 'canonical_url',
  },
}));

vi.mock('@/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));

const mockIngest = vi.fn();
const mockBatchIngest = vi.fn();
vi.mock('@/lib/triage/import-capture', () => ({
  ingestTriageImports: mockBatchIngest,
}));

const mockGetSyncState = vi.fn();
const mockRecordSyncRun = vi.fn();
vi.mock('@/lib/triage/sync-state', () => ({
  getSyncState: mockGetSyncState,
  recordSyncRun: mockRecordSyncRun,
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Document Intelligence Importer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIngest.mockResolvedValue({ status: 'imported', id: 'test-id' });
    mockBatchIngest.mockImplementation(async (inputs: unknown[]) =>
      Promise.all(inputs.map((input) => mockIngest(input))));
    mockGetSyncState.mockResolvedValue(null);
    mockRecordSyncRun.mockResolvedValue({ status: 'applied' });
  });

  describe('importDocumentIntelligenceActions', () => {
    it('fetches pending actions and ingests them', async () => {
      const mockActions = [
        {
          id: '9',
          document_id: 9647,
          document_title: 'CVS - Quinn post-op',
          action_type: 'pay',
          urgency: 'low',
          amount: 79.59,
          correspondent: 'CVS Pharmacy',
          summary: 'Payment for prescription charges.',
          status: 'pending',
          created_at: '2026-07-25T01:16:08',
          document_url: 'https://paperless.example/documents/9647/details',
          needs_review_url: 'javascript:alert(1)',
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockActions),
        headers: new Headers(),
      });

      const { importDocumentIntelligenceActions } = await import(
        '@/lib/triage/importers/document-intelligence-importer'
      );

      const summary = await importDocumentIntelligenceActions({
        baseUrl: 'https://doc-intel.example',
        apiKey: 'test-key',
        paperlessBaseUrl: 'https://paperless.example',
      });

      expect(summary.imported).toBe(1);
      expect(summary.skipped).toBe(0);
      expect(summary.errors).toHaveLength(0);

      expect(mockIngest).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePlatform: 'document-intelligence',
          sourceId: 'docintel-action-9',
          sourceUrl: 'https://paperless.example/documents/9647/details',
          title: expect.stringContaining('CVS Pharmacy'),
          rawMetadata: expect.objectContaining({
            reviewUrl: null,
          }),
        }),
      );
    });

    it('skips actions missing id or document_title', async () => {
      const mockActions = [
        { id: '', document_title: '', action_type: 'pay', summary: '', status: 'pending', document_id: 1, urgency: 'low', created_at: '' },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockActions),
        headers: new Headers(),
      });

      const { importDocumentIntelligenceActions } = await import(
        '@/lib/triage/importers/document-intelligence-importer'
      );

      const summary = await importDocumentIntelligenceActions({
        baseUrl: 'https://doc-intel.example',
      });

      expect(summary.skipped).toBe(1);
      expect(summary.imported).toBe(0);
      expect(mockIngest).not.toHaveBeenCalled();
    });

    it('skips actions OWL explicitly marks as not ready while retaining legacy fallback', async () => {
      const baseAction = {
        document_id: 1,
        document_title: 'Uncertain document',
        action_type: 'review',
        urgency: 'medium',
        summary: 'Needs confirmation',
        status: 'pending',
        created_at: '2026-07-20T10:00:00',
      };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([
          { ...baseAction, id: 'not-ready', action_ready: false, review_state: 'needs_review' },
          { ...baseAction, id: 'legacy' },
        ]),
        headers: new Headers(),
      });
      const { importDocumentIntelligenceActions } = await import(
        '@/lib/triage/importers/document-intelligence-importer'
      );

      const summary = await importDocumentIntelligenceActions({
        baseUrl: 'https://doc-intel.example',
      });

      expect(summary).toMatchObject({ imported: 1, skipped: 1 });
      expect(mockIngest).toHaveBeenCalledTimes(1);
      expect(mockIngest).toHaveBeenCalledWith(expect.objectContaining({
        sourceId: 'docintel-action-legacy',
      }));
    });

    it('deduplicates already-imported actions', async () => {
      mockIngest.mockResolvedValue({ status: 'skipped', id: 'existing-id' });

      const mockActions = [
        {
          id: '5',
          document_id: 100,
          document_title: 'Existing Doc',
          action_type: 'review',
          urgency: 'medium',
          summary: 'Review needed.',
          status: 'pending',
          created_at: '2026-07-20T10:00:00',
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockActions),
        headers: new Headers(),
      });

      const { importDocumentIntelligenceActions } = await import(
        '@/lib/triage/importers/document-intelligence-importer'
      );

      const summary = await importDocumentIntelligenceActions({
        baseUrl: 'https://doc-intel.example',
      });

      expect(summary.imported).toBe(0);
      expect(summary.skipped).toBe(1);
    });

    it('throws on non-OK response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers(),
      });

      const { importDocumentIntelligenceActions } = await import(
        '@/lib/triage/importers/document-intelligence-importer'
      );

      await expect(
        importDocumentIntelligenceActions({ baseUrl: 'https://doc-intel.example' }),
      ).rejects.toThrow('Document intelligence import failed: 503');
    });

    it('persists oversized remote responses in bounded batches without dropping items', async () => {
      const actions = Array.from({ length: 105 }, (_, index) => ({
        id: String(index),
        document_id: index,
        document_title: `Document ${index}`,
        action_type: 'review',
        urgency: 'medium',
        summary: 'Review needed',
        status: 'pending',
        created_at: '2026-07-20T10:00:00',
      }));
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(actions),
        headers: new Headers(),
      });
      const { importDocumentIntelligenceActions, MAX_DOCUMENT_INTELLIGENCE_BATCH_SIZE } =
        await import('@/lib/triage/importers/document-intelligence-importer');

      const summary = await importDocumentIntelligenceActions({
        baseUrl: 'https://doc-intel.example',
      });

      expect(mockBatchIngest).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ sourceId: 'docintel-action-0' })]),
      );
      expect(mockBatchIngest.mock.calls[0][0]).toHaveLength(MAX_DOCUMENT_INTELLIGENCE_BATCH_SIZE);
      expect(mockBatchIngest.mock.calls[1][0]).toHaveLength(5);
      expect(summary).toMatchObject({ imported: 105, skipped: 0, errors: [] });
    });
  });

  describe('importAllDocumentIntelligenceActions', () => {
    it('persists sync state after import', async () => {
      const mockActions = [
        {
          id: '1',
          document_id: 1,
          document_title: 'Test Doc',
          action_type: 'pay',
          urgency: 'low',
          amount: 10.0,
          correspondent: 'Test',
          summary: 'Test',
          status: 'pending',
          created_at: '2026-07-25T00:00:00',
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockActions),
        headers: new Headers(),
      });

      const { importAllDocumentIntelligenceActions } = await import(
        '@/lib/triage/importers/document-intelligence-importer'
      );

      const result = await importAllDocumentIntelligenceActions({
        baseUrl: 'https://doc-intel.example',
      });

      expect(result.imported).toBe(1);
      expect(result.pagesProcessed).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockRecordSyncRun).toHaveBeenCalledWith(
        'document-intelligence',
        0,
        expect.objectContaining({ imported: 1, skipped: 0 }),
      );
    });

    it('does not expose remote secrets in persisted failures', async () => {
      const secret = 'synthetic-di-secret';
      global.fetch = vi.fn().mockRejectedValue(new Error(`network failed ${secret}`));
      const { importAllDocumentIntelligenceActions } = await import(
        '@/lib/triage/importers/document-intelligence-importer'
      );

      const result = await importAllDocumentIntelligenceActions({
        baseUrl: 'https://doc-intel.example',
        apiKey: secret,
      });

      expect(result.outcome).toBe('failure');
      expect(JSON.stringify(result.errors)).not.toContain(secret);
      expect(JSON.stringify(mockRecordSyncRun.mock.calls)).not.toContain(secret);
    });
  });
});

describe('ALLOWED_SOURCES', () => {
  it('includes document-intelligence', async () => {
    // Read the source file and check the set contains our source
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../../src/lib/triage/query.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain("'document-intelligence'");
  });
});
