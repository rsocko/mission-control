import type Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('drizzle-orm');

let sqlite: Database.Database;
let resetDemoDatabase: () => Promise<void>;
let canonicalHistoryCount: number;

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mc-demo-seed-'));
  process.env.MC_DB_PATH = join(directory, 'demo.db');

  ({ sqlite } = await import('@/db'));
  sqlite.prepare('SELECT 1').get();
  ({ resetDemoDatabase } = await import('@/lib/seed-api'));
  await resetDemoDatabase();
  canonicalHistoryCount = count('task_history_events');
});

function count(table: string): number {
  const safeTable = table.replaceAll('"', '""');
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM "${safeTable}"`).get() as { count: number };
  return row.count;
}

describe('canonical demo seed', () => {
  it('seeds representative modern feature scenarios', () => {
    expect(count('tasks')).toBeGreaterThan(60);
    expect(count('triage_items')).toBe(4);
    expect(count('project_phase_items')).toBeGreaterThanOrEqual(9);
    expect(count('task_dependencies')).toBeGreaterThanOrEqual(4);
    expect(count('task_history_events')).toBeGreaterThanOrEqual(12);
    expect(count('task_field_states')).toBeGreaterThanOrEqual(3);
    expect(count('task_linked_sources')).toBeGreaterThanOrEqual(1);
    expect(count('task_attachments')).toBeGreaterThanOrEqual(1);
    expect(count('sync_jobs')).toBeGreaterThanOrEqual(3);
    expect(count('scout_reconciliation_suggestions')).toBe(1);

    const richTask = sqlite.prepare(`
      SELECT connector_type AS connectorType, description, effort
      FROM tasks
      WHERE id = 't-local-plan'
    `).get() as { connectorType: string; description: string; effort: number };
    expect(richTask.connectorType).toBe('local');
    expect(richTask.description).toContain('## Demo goals');
    expect(richTask.effort).toBe(4);

    const phaseMembership = sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM project_phase_items
      WHERE phase_id = 'phase-kr-install'
    `).get() as { count: number };
    expect(phaseMembership.count).toBe(4);
  });

  it('drives progress reporting', async () => {
    const { getBurnReport } = await import('@/lib/reports/burn');
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 45);

    const report = await getBurnReport({
      projectId: 'proj-kitchen-reno',
      mode: 'count',
      startDate: start.toISOString().slice(0, 10),
      endDate: today,
      today,
    });

    expect(report?.points.some((point) => (point.completed ?? 0) > 0)).toBe(true);
  });

  it('drives Scout suggestion services', async () => {
    const { listReconciliationSuggestions } = await import(
      '@/lib/connectors/scout/reconciliation-service'
    );
    const suggestions = await listReconciliationSuggestions();

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      taskId: 't-scout-active',
      action: 'suggest-complete',
    });
  });

  it('replaces stale data and restores the append-only history guard', async () => {
    sqlite.prepare(`
      INSERT INTO task_history_events (
        task_id, event_type, occurred_at, recorded_at, provenance
      ) VALUES ('stale-demo-task', 'baseline', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', 'test')
    `).run();
    await resetDemoDatabase();

    expect(count('task_history_events')).toBe(canonicalHistoryCount);
    expect(() => sqlite.prepare(`
      DELETE FROM task_history_events WHERE task_id = 't-hr1'
    `).run()).toThrow(/append-only/);
  });
});
