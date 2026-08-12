import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFinanceExternalTargetLink,
} from '@/lib/finance/external-links';
import {
  FINANCE_PROVIDER_ALIASES,
  normalizeFinanceProviderAlias,
} from '@/lib/finance-insights/provider';

afterEach(() => {
  delete process.env.MONARCH_WEB_URL;
  delete process.env.PAPERLESS_BASE_URL;
  delete process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS;
  delete process.env.FINANCE_OWL_ALLOWED_HOSTS;
});

describe('finance insight aliases and safe target registry', () => {
  it('normalizes the complete finance provider alias family', () => {
    expect(FINANCE_PROVIDER_ALIASES).toEqual([
      'finance',
      'finance-manager',
      'monarch-money',
    ]);
    for (const alias of FINANCE_PROVIDER_ALIASES) {
      expect(normalizeFinanceProviderAlias(alias)).toBe('finance-manager');
    }
    expect(normalizeFinanceProviderAlias('custom-rest')).toBeNull();
  });

  it('builds a verified transaction mapping and safe Monarch root fallbacks', () => {
    expect(buildFinanceExternalTargetLink({
      system: 'monarch',
      targetKind: 'transaction',
      sourceRef: 'transaction-one',
    }, {
      monarchTransactionIds: { 'transaction-one': 'upstream-transaction-one' },
    })).toEqual({
      system: 'monarch',
      label: 'Open transaction in Monarch',
      url: 'https://app.monarchmoney.com/transactions?transactionId=upstream-transaction-one',
    });
    expect(buildFinanceExternalTargetLink({
      system: 'monarch',
      targetKind: 'transaction',
      sourceRef: 'missing-transaction',
    })?.url).toBe('https://app.monarchmoney.com/transactions');
    expect(buildFinanceExternalTargetLink({
      system: 'monarch',
      targetKind: 'recurring',
      sourceRef: 'recurring-one',
    })?.url).toBe('https://app.monarchmoney.com/recurring');
    expect(buildFinanceExternalTargetLink({
      system: 'monarch',
      targetKind: 'reportFilter',
      reportKind: 'spending',
      period: { start: '2026-08-01', end: '2026-08-10' },
      categorySourceRef: null,
      merchantKey: null,
    })?.url).toBe('https://app.monarchmoney.com/reports');
  });

  it('removes unsupported OWL actions and builds only mapped allowlisted documents', () => {
    process.env.PAPERLESS_BASE_URL = 'http://localhost:8000';
    const target = {
      system: 'owl',
      targetKind: 'document',
      sourceRef: 'owl-document-ref',
    };
    expect(buildFinanceExternalTargetLink(target)).toBeNull();
    expect(buildFinanceExternalTargetLink(target, {
      owlDocumentIds: { 'owl-document-ref': 42 },
    })).toEqual({
      system: 'owl',
      label: 'Open document in OWL',
      url: 'http://localhost:8000/documents/42/details',
    });
  });

  it('rejects arbitrary URLs, credentials, unsupported hosts, and malformed mappings', () => {
    expect(buildFinanceExternalTargetLink({
      system: 'monarch',
      targetKind: 'safeRoot',
      root: 'transactions',
      url: 'https://attacker.example',
    })).toBeNull();
    expect(buildFinanceExternalTargetLink({
      system: 'tyrion',
      targetKind: 'url',
      url: 'https://tyrion.example/private',
    })).toBeNull();
    process.env.MONARCH_WEB_URL = 'https://attacker.example';
    expect(() => buildFinanceExternalTargetLink({
      system: 'monarch',
      targetKind: 'safeRoot',
      root: 'transactions',
    })).toThrow('Finance external URL is not approved');

    delete process.env.MONARCH_WEB_URL;
    process.env.PAPERLESS_BASE_URL = 'https://user:password@paperless.example';
    process.env.FINANCE_OWL_ALLOWED_HOSTS = 'paperless.example';
    expect(() => buildFinanceExternalTargetLink({
      system: 'owl',
      targetKind: 'document',
      sourceRef: 'doc-one',
    }, {
      owlDocumentIds: { 'doc-one': '../admin' },
    })).not.toThrow();
    expect(buildFinanceExternalTargetLink({
      system: 'owl',
      targetKind: 'document',
      sourceRef: 'doc-one',
    }, {
      owlDocumentIds: { 'doc-one': '../admin' },
    })).toBeNull();
  });
});
