import { describe, expect, it } from 'vitest';
import {
  buildConnectorSettingsHref,
  readConnectorSettingsState,
} from '@/app/settings/connector-settings-navigation';

describe('connector settings navigation', () => {
  it('reads connector and validated tab state', () => {
    expect(readConnectorSettingsState('?connector=github-1&tab=notifications')).toEqual({
      connectorId: 'github-1',
      tab: 'notifications',
    });
    expect(readConnectorSettingsState('?connector=github-1&tab=unknown')).toEqual({
      connectorId: 'github-1',
      tab: 'general',
    });
  });

  it('preserves unrelated query parameters when opening, changing, and closing', () => {
    const current = 'https://mission-control.test/settings/connectors?setting=sync#connector-list';
    const opened = buildConnectorSettingsHref(current, 'github-1', 'sources');
    expect(opened).toBe('/settings/connectors?setting=sync&connector=github-1&tab=sources#connector-list');
    expect(buildConnectorSettingsHref(
      `https://mission-control.test${opened}`,
      'github-1',
      'access',
    )).toBe('/settings/connectors?setting=sync&connector=github-1&tab=access#connector-list');
    expect(buildConnectorSettingsHref(
      `https://mission-control.test${opened}`,
      null,
    )).toBe('/settings/connectors?setting=sync#connector-list');
  });
});
