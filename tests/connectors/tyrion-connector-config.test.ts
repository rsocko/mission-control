import { describe, expect, it } from 'vitest';
import {
  preserveFinanceConnectorIdentityCredentials,
  protectNewFinanceConnectorCredentials,
  redactFinanceConnector,
  sanitizeFinanceConnectorWrite,
} from '@/lib/connectors/monarch-money/config';
import { serializeConnectorForBrowser } from '@/lib/connectors/public-config';
import { defaultTyrionBridgeUrlForEnvironment } from '@/lib/connectors/monarch-money/constants';
import {
  financeConnectorScopedReference,
  validateFinanceConnectorScopedReference,
} from '@/lib/connectors/monarch-money/identity';

describe('Tyrion connector configuration boundary', () => {
  it('defaults local setup to loopback and production to the protected gateway', () => {
    expect(defaultTyrionBridgeUrlForEnvironment('development')).toBe('http://localhost:8100');
    expect(defaultTyrionBridgeUrlForEnvironment('test')).toBe('http://localhost:8100');
    expect(defaultTyrionBridgeUrlForEnvironment('production'))
      .toBe('https://tyrion.example/api/connector/v1');
  });

  it('persists the canonical bridge origin and setup token while discarding token aliases', () => {
    expect(sanitizeFinanceConnectorWrite({
      type: 'finance-manager',
      credentials: {
        serviceToken: 'canonical-setup-token',
        bridgeToken: 'must-not-persist',
        apiToken: 'must-not-persist',
      },
      settings: {
        bridgeUrl: 'http://tyrion-bridge:8100/bridge/v1/',
        serviceToken: 'must-not-persist-in-settings',
        timeoutMs: 5000,
      },
    })).toEqual({
      type: 'finance-manager',
      credentials: { serviceToken: 'canonical-setup-token' },
      settings: { bridgeUrl: 'http://tyrion-bridge:8100/bridge/v1', timeoutMs: 5000 },
    });
  });

  it('creates and preserves protected connector identity state without exposing it', () => {
    const created = protectNewFinanceConnectorCredentials({
      serviceToken: 'canonical-setup-token',
    });
    expect(created.identityNamespace).toMatch(/^[a-f0-9]{64}$/);
    const updated = preserveFinanceConnectorIdentityCredentials(
      { serviceToken: 'replacement-token' },
      created,
    );
    expect(updated).toEqual({
      serviceToken: 'replacement-token',
      identityNamespace: created.identityNamespace,
    });
    expect(redactFinanceConnector({
      type: 'finance-manager',
      credentials: updated,
      settings: {},
    }).credentials).toEqual({});
  });

  it('drops obsolete fingerprint rollout settings from writes', () => {
    expect(sanitizeFinanceConnectorWrite({
      type: 'finance-manager',
      credentials: {},
      settings: {
        householdCurrency: 'USD',
        cardRuleFingerprintParityProven: true,
        cardRuleFingerprintParityProvenAt: '2026-08-22T00:00:00.000Z',
      },
    }).settings).toEqual({ householdCurrency: 'USD' });
  });

  it('always derives raw identifiers even when they resemble scoped references', () => {
    const namespace = 'a'.repeat(64);
    const raw = `account-v1:${'B'.repeat(43)}`;
    const derived = financeConnectorScopedReference(namespace, 'account', raw);

    expect(derived).not.toBe(raw);
    expect(validateFinanceConnectorScopedReference('account', derived)).toBe(derived);
    expect(() => validateFinanceConnectorScopedReference('account', 'raw-account-id')).toThrow();
  });

  it('redacts legacy token aliases and suppresses unsafe legacy URLs from public DTOs', () => {
    const publicConnector = redactFinanceConnector({
      type: 'monarch-money',
      credentials: { bridgeToken: 'must-not-leak' },
      settings: { bridgeUrl: 'https://must-not-leak.invalid/v1/../capture', maxRetries: 1 },
    });

    expect(publicConnector).toEqual({
      type: 'monarch-money',
      credentials: {},
      settings: { maxRetries: 1 },
    });
    expect(JSON.stringify(publicConnector)).not.toContain('must-not-leak');
  });

  it('does not alter other connector types', () => {
    const connector = {
      type: 'custom-rest',
      credentials: { apiToken: 'other-connector-token' },
      settings: { bridgeUrl: 'https://other.example' },
    };

    expect(sanitizeFinanceConnectorWrite(connector)).toBe(connector);
  });

  it('redacts credentials from every connector browser DTO without hiding presence', () => {
    const publicConnector = serializeConnectorForBrowser({
      type: 'github-issues',
      credentials: JSON.stringify({ accessToken: 'must-not-round-trip' }),
      settings: JSON.stringify({ repos: ['octo/example'] }),
    });

    expect(publicConnector).toMatchObject({
      type: 'github-issues',
      credentials: {},
      hasCredentials: true,
      settings: { repos: ['octo/example'] },
    });
    expect(JSON.stringify(publicConnector)).not.toContain('must-not-round-trip');
  });
});
