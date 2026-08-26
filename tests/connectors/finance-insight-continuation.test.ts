import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncResult } from '@/types';

vi.unmock('drizzle-orm');

const directory = mkdtempSync(join(tmpdir(), 'mc-finance-continuation-'));
process.env.MC_DB_PATH = join(directory, 'continuation.db');

let database: typeof import('@/db');
let queue: typeof import('@/lib/sync/job-queue');
let enqueueFinanceInsightContinuation:
  typeof import('@/lib/finance-insights/continuation')['enqueueFinanceInsightContinuation'];
let findFinanceInsightContinuationPublicationId:
  typeof import('@/lib/finance-insights/orchestrator')['findFinanceInsightContinuationPublicationId'];

function success(): SyncResult {
  return {
    connectorId: 'finance-continuation',
    success: true,
    tasksAdded: 0,
    tasksUpdated: 0,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: [],
    syncedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  database = await import('@/db');
  queue = await import('@/lib/sync/job-queue');
  ({ enqueueFinanceInsightContinuation } = await import('@/lib/finance-insights/continuation'));
  ({ findFinanceInsightContinuationPublicationId } = await import(
    '@/lib/finance-insights/orchestrator'
  ));
});

beforeEach(() => {
  database.sqlite.prepare('DELETE FROM connector_operation_leases').run();
  database.sqlite.prepare('DELETE FROM sync_jobs').run();
  database.sqlite.prepare('DELETE FROM finance_insight_publication_delivery').run();
  database.sqlite.prepare('DELETE FROM finance_insight_publications').run();
  database.sqlite.prepare('DELETE FROM connector_configs').run();
  const now = new Date().toISOString();
  database.sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
      credentials, settings, synced_lists, created_at, updated_at
    ) VALUES (
      'finance-continuation', 'finance-manager', 'Finance', 1, 'poll', 5, '{}',
      '{}', '{}', '[]', ?, ?
    )
  `).run(now, now);
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe.sequential('finance insight durable continuation', () => {
  it('deduplicates delayed work and survives worker restart under the connector lease', async () => {
    const active = queue.enqueueSyncJob('finance-continuation');
    expect(queue.claimNextSyncJob('worker-before-restart')?.id).toBe(active.id);
    const now = new Date();

    const first = await enqueueFinanceInsightContinuation({
      connectorId: 'finance-continuation',
      jobId: active.id,
      now,
      environment: { TYRION_FINANCE_INSIGHTS_CONTINUATION_DELAY_MS: '60000' },
    });
    const replay = await enqueueFinanceInsightContinuation({
      connectorId: 'finance-continuation',
      jobId: active.id,
      now,
      environment: { TYRION_FINANCE_INSIGHTS_CONTINUATION_DELAY_MS: '60000' },
    });

    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({
      status: 'queued',
      source: 'recovery',
      availableAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    expect(queue.claimNextSyncJob('competing-worker')).toBeNull();

    queue.completeSyncJob(active.id, 'worker-before-restart', success());
    expect(queue.claimNextSyncJob('worker-after-restart')).toBeNull();
    database.sqlite.prepare(`
      UPDATE sync_jobs SET available_at = ? WHERE id = ?
    `).run(new Date(now.getTime() - 1).toISOString(), first.id);
    expect(queue.claimNextSyncJob('worker-after-restart')).toMatchObject({
      id: first.id,
      connectorId: 'finance-continuation',
      status: 'running',
    });
  });

  it('rejects continuation without the active durable lease', async () => {
    await expect(enqueueFinanceInsightContinuation({
      connectorId: 'finance-continuation',
      jobId: 'not-the-active-job',
    })).rejects.toThrow('finance_insight_continuation_lease_unavailable');
    expect(queue.getSyncQueueMetrics().queued).toBe(0);
  });

  it('selects the newest persisted pending or retryable evaluation', () => {
    const now = new Date().toISOString();
    const insertPublication = database.sqlite.prepare(`
      INSERT INTO finance_insight_publications (
        id, connector_id, source_sequence, generation_identity, contract_version,
        provider_type, source_as_of, coverage_start, coverage_end, currency,
        bridge_contract_version, captured_constituents, manifest, manifest_digest,
        create_request, idempotency_key, alert_capable, captured_at, expires_at
      ) VALUES (?, 'finance-continuation', ?, ?, '1', 'finance-manager', ?, ?, ?,
                'USD', '1', '[]', '{}', ?, '{}', ?, 1, ?, ?)
    `);
    const insertDelivery = database.sqlite.prepare(`
      INSERT INTO finance_insight_publication_delivery (
        publication_id, connector_id, source_sequence, stage, evaluation_state,
        last_error_retryable, created_at, updated_at
      ) VALUES (?, 'finance-continuation', ?, 'evaluation-requested', ?, ?, ?, ?)
    `);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    for (const [id, sequence] of [
      ['completed-publication', 1],
      ['queued-publication', 2],
      ['retryable-publication', 3],
    ] as const) {
      insertPublication.run(
        id,
        sequence,
        `identity-${sequence}`,
        now,
        now,
        now,
        `digest-${sequence}`,
        `key-${sequence}`,
        now,
        expiresAt,
      );
    }
    insertDelivery.run('completed-publication', 1, 'completed', 0, now, now);
    insertDelivery.run('queued-publication', 2, 'queued', 0, now, now);
    insertDelivery.run('retryable-publication', 3, null, 1, now, now);

    expect(findFinanceInsightContinuationPublicationId('finance-continuation'))
      .toBe('retryable-publication');
    database.sqlite.prepare(`
      UPDATE finance_insight_publication_delivery
      SET last_error_retryable = 0
      WHERE publication_id = 'retryable-publication'
    `).run();
    expect(findFinanceInsightContinuationPublicationId('finance-continuation'))
      .toBe('queued-publication');
    expect(findFinanceInsightContinuationPublicationId('other-connector')).toBeNull();
  });
});
