import { describe, expect, it, vi } from 'vitest';
import {
  normalizeLimit,
  parseIssueNumberQuery,
  PostgresKeywordSearchRepository,
  truncate,
} from '@/db/postgres/search';

describe('PostgreSQL keyword search repository — pure helpers', () => {
  describe('normalizeLimit', () => {
    it('defaults to 20', () => {
      expect(normalizeLimit(undefined)).toBe(20);
    });

    describe('PostgreSQL keyword search repository', () => {
      it('rebuilds both projections in one transaction', async () => {
        const query = vi.fn().mockResolvedValue({ rows: [] });
        const release = vi.fn();
        const repository = new PostgresKeywordSearchRepository({
          connect: vi.fn().mockResolvedValue({ query, release }),
        } as never);

        await repository.rebuild();

        expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
        expect(query).toHaveBeenLastCalledWith('COMMIT');
        expect(release).toHaveBeenCalledOnce();
      });

      it('rolls back and releases when a rebuild fails', async () => {
        const failure = new Error('backfill failed');
        const query = vi.fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockRejectedValueOnce(failure)
          .mockResolvedValueOnce({ rows: [] });
        const release = vi.fn();
        const repository = new PostgresKeywordSearchRepository({
          connect: vi.fn().mockResolvedValue({ query, release }),
        } as never);

        await expect(repository.rebuild()).rejects.toBe(failure);

        expect(query).toHaveBeenLastCalledWith('ROLLBACK');
        expect(release).toHaveBeenCalledOnce();
      });

      it('pushes Universe visibility predicates before the task result limit', async () => {
        const query = vi.fn().mockResolvedValue({ rows: [] });
        const repository = new PostgresKeywordSearchRepository({ query } as never);

        await repository.search('planning', {
          type: 'tasks',
          universeEligible: true,
          excludeConnectorInstanceIds: ['deleted-connector'],
          limit: 20,
        });

        const [sql, params] = query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('t.parent_id IS NULL');
        expect(sql).toContain("t.local_disposition = 'active'");
        expect(sql).toContain('t.connector_type = ANY($8::text[])');
        expect(sql).toContain('t.connector_instance_id = ANY($9::text[])');
        expect(sql.indexOf('t.parent_id IS NULL')).toBeLessThan(sql.indexOf('LIMIT $10'));
        expect(params[8]).toEqual(['deleted-connector']);
      });

      it('pushes date predicates before the task result limit', async () => {
        const query = vi.fn().mockResolvedValue({ rows: [] });
        const repository = new PostgresKeywordSearchRepository({ query } as never);

        await repository.search('planning', {
          type: 'tasks',
          dateFrom: '2030-01-01T00:00:00.000Z',
          dueBefore: '2030-02-01T00:00:00.000Z',
          limit: 20,
        });

        const [sql, params] = query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain("COALESCE(NULLIF(t.due_date, ''), t.updated_at) >= $4");
        expect(sql).toContain('t.due_date < $5');
        expect(sql.indexOf('t.due_date < $5')).toBeLessThan(sql.indexOf('LIMIT $10'));
        expect(params.slice(3, 5)).toEqual([
          '2030-01-01T00:00:00.000Z',
          '2030-02-01T00:00:00.000Z',
        ]);
      });

      it('pushes mobile notification kinds before the notification result limit', async () => {
        const query = vi.fn().mockResolvedValue({ rows: [] });
        const repository = new PostgresKeywordSearchRepository({ query } as never);

        await repository.search('planning', {
          type: 'notifications',
          notificationKind: 'notes',
          limit: 20,
        });

        const [sql, params] = query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain("($4 = 'notes' AND");
        expect(sql).toContain("STRPOS(LOWER(");
        expect(sql.indexOf("($4 = 'notes' AND")).toBeLessThan(sql.indexOf('LIMIT $8'));
        expect(params[3]).toBe('notes');
      });
    });

    it('clamps to a minimum of 1', () => {
      expect(normalizeLimit(0)).toBe(1);
      expect(normalizeLimit(-5)).toBe(1);
    });

    it('clamps to a maximum of 50', () => {
      expect(normalizeLimit(500)).toBe(50);
    });
  });

  describe('truncate', () => {
    it('returns an empty string for nullish input', () => {
      expect(truncate(null)).toBe('');
      expect(truncate(undefined)).toBe('');
      expect(truncate('   ')).toBe('');
    });

    it('leaves short text untouched', () => {
      expect(truncate('hello world')).toBe('hello world');
    });

    it('truncates long text with an ellipsis', () => {
      const long = 'a'.repeat(200);
      const result = truncate(long, 160);
      expect(result.length).toBe(160);
      expect(result.endsWith('…')).toBe(true);
    });
  });

  describe('parseIssueNumberQuery', () => {
    it('parses a bare issue number', () => {
      expect(parseIssueNumberQuery('123')).toBe(123);
    });

    it('parses a hash-prefixed issue number', () => {
      expect(parseIssueNumberQuery('#456')).toBe(456);
    });

    it('rejects non-numeric queries', () => {
      expect(parseIssueNumberQuery('bug report')).toBeNull();
    });

    it('rejects zero and negative-looking queries', () => {
      expect(parseIssueNumberQuery('0')).toBeNull();
      expect(parseIssueNumberQuery('#0')).toBeNull();
    });

    it('rejects queries mixing digits with other text', () => {
      expect(parseIssueNumberQuery('issue 123')).toBeNull();
      expect(parseIssueNumberQuery('123abc')).toBeNull();
    });
  });
});
