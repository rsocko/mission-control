import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('finance transaction location migrations', () => {
  it.each([
    ['SQLite', 'drizzle/0158_finance_transaction_location_evidence.sql'],
    ['Postgres', 'drizzle/postgres/0036_finance_transaction_location_evidence.sql'],
  ])('adds descriptor and location evidence columns for %s', (_backend, path) => {
    const sql = readFileSync(path, 'utf8');
    expect(sql).toContain('statement_descriptors');
    expect(sql).toContain('location_evidence');
    expect(sql).toContain('location_evidence_input_fingerprint');
    expect(sql).toContain('location_inference_evidence');
    expect(sql).toContain('location_inference_error_code');
  });
});
