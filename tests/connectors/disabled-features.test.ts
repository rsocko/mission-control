import { describe, expect, it } from 'vitest';
import { getDisabledConnectorFeatures } from '@/lib/connectors/disabled-features';

describe('getDisabledConnectorFeatures', () => {
  it('omits connector types that have never been configured', () => {
    expect(getDisabledConnectorFeatures([])).toEqual([]);
  });

  it('includes configured connectors only when every matching config is disabled', () => {
    expect(getDisabledConnectorFeatures([
      { type: 'microsoft-todo', enabled: false },
      { type: 'github-issues', enabled: true },
    ])).toEqual(['Microsoft Todo']);
  });

  it('treats finance connector variants as one feature', () => {
    expect(getDisabledConnectorFeatures([
      { type: 'finance', enabled: false },
      { type: 'finance-manager', enabled: false },
      { type: 'monarch-money', enabled: true },
    ])).toEqual([]);
  });
});
