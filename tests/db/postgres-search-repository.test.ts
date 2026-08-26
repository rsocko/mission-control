import { describe, expect, it } from 'vitest';
import {
  normalizeLimit,
  parseIssueNumberQuery,
  truncate,
} from '@/db/postgres/search';

describe('PostgreSQL keyword search repository — pure helpers', () => {
  describe('normalizeLimit', () => {
    it('defaults to 20', () => {
      expect(normalizeLimit(undefined)).toBe(20);
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
