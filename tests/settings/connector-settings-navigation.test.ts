import { describe, expect, it, vi } from 'vitest';
import {
  buildConnectorSettingsHref,
  readConnectorSettingsState,
  updateConnectorSettingsHistory,
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

  it('updates connector deeplinks without triggering an app-router navigation', () => {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const history = {
      state: { nextNavigation: 'preserved' },
      pushState,
      replaceState,
    };
    const current = 'https://mission-control.test/settings/connectors?setting=sync';

    expect(updateConnectorSettingsHistory(
      history,
      current,
      'github-1',
      'general',
    )).toBe('/settings/connectors?setting=sync&connector=github-1&tab=general');
    expect(pushState).toHaveBeenCalledWith(
      history.state,
      '',
      '/settings/connectors?setting=sync&connector=github-1&tab=general',
    );

    expect(updateConnectorSettingsHistory(
      history,
      current,
      'github-1',
      'access',
      true,
    )).toBe('/settings/connectors?setting=sync&connector=github-1&tab=access');
    expect(replaceState).toHaveBeenCalledWith(
      history.state,
      '',
      '/settings/connectors?setting=sync&connector=github-1&tab=access',
    );
  });
});
