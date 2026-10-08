import { describe, expect, it } from 'vitest';
import {
  connectorClassificationOptions,
  connectorClassificationSummary,
  resolveConnectorDataClassification,
  validateConnectorClassificationOverride,
  withConnectorClassificationOverride,
} from '@/lib/connectors/data-classification';
import { DEFAULT_AI_ROUTING_POLICY } from '@/lib/ai/sensitivity-policy';

describe('connector data classification', () => {
  it('uses secure source defaults', () => {
    expect(resolveConnectorDataClassification('github-issues', {})).toBe('standard');
    expect(resolveConnectorDataClassification('outlook-email', {})).toBe('restricted');
    expect(resolveConnectorDataClassification('unknown-connector', {})).toBe('restricted');
  });

  it('allows only stricter per-connector overrides', () => {
    expect(validateConnectorClassificationOverride(
      'github-issues',
      'restricted',
    )).toBe('restricted');
    expect(validateConnectorClassificationOverride(
      'outlook-email',
      'local-only',
    )).toBe('local-only');
    expect(() => validateConnectorClassificationOverride(
      'outlook-email',
      'standard',
    )).toThrow('Restricted is the minimum classification');
  });

  it('treats a baseline-equivalent override as automatic', () => {
    expect(validateConnectorClassificationOverride(
      'github-issues',
      'standard',
    )).toBeNull();
    expect(withConnectorClassificationOverride(
      { dataClassificationOverride: 'restricted', keep: true },
      null,
    )).toEqual({ keep: true });
  });

  it('resolves against the live policy before applying an override', () => {
    const policy = structuredClone(DEFAULT_AI_ROUTING_POLICY);
    policy.sourceDefaults['github-issues'] = 'restricted';
    expect(connectorClassificationSummary(
      'github-issues',
      { dataClassificationOverride: 'local-only' },
      policy,
    )).toEqual({
      baseline: 'restricted',
      effective: 'local-only',
      override: 'local-only',
    });
    expect(connectorClassificationOptions('restricted')).toEqual([
      'restricted',
      'local-only',
    ]);
  });
});
