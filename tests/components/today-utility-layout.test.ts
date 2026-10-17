import { describe, expect, it } from 'vitest';
import {
  TODAY_DETAIL_PANEL_MIN_WIDTH,
  resolveTodayUtilityVisibility,
  type TodayUtilityPreferences,
} from '@/components/today/today-utility-layout';

const defaultPreferences: TodayUtilityPreferences = {
  planOpen: true,
  notificationsOpen: false,
  activePanel: 'plan',
};

describe('My Day utility layout', () => {
  it('honors the saved pane visibility when task detail is closed', () => {
    expect(resolveTodayUtilityVisibility(defaultPreferences, 900, false)).toEqual({
      plan: true,
      notifications: false,
      constrainedDetail: false,
    });
    expect(resolveTodayUtilityVisibility({
      planOpen: true,
      notificationsOpen: true,
      activePanel: 'notifications',
    }, 900, false)).toEqual({
      plan: true,
      notifications: true,
      constrainedDetail: false,
    });
  });

  it('temporarily hides saved panes when task detail is constrained', () => {
    expect(resolveTodayUtilityVisibility({
      planOpen: true,
      notificationsOpen: true,
      activePanel: 'notifications',
    }, TODAY_DETAIL_PANEL_MIN_WIDTH - 1, true)).toEqual({
      plan: false,
      notifications: false,
      constrainedDetail: true,
    });
  });

  it('keeps the active saved pane beside task detail on wide workspaces', () => {
    expect(resolveTodayUtilityVisibility({
      planOpen: true,
      notificationsOpen: true,
      activePanel: 'notifications',
    }, TODAY_DETAIL_PANEL_MIN_WIDTH, true)).toEqual({
      plan: false,
      notifications: true,
      constrainedDetail: false,
    });
  });
});
