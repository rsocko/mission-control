export const TODAY_DETAIL_PANEL_MIN_WIDTH = 1320;

export type TodayUtilityPanel = 'plan' | 'notifications';

export interface TodayUtilityPreferences {
  planOpen: boolean;
  notificationsOpen: boolean;
  activePanel: TodayUtilityPanel;
}

export interface TodayUtilityVisibility {
  plan: boolean;
  notifications: boolean;
  constrainedDetail: boolean;
}

export function resolveTodayUtilityVisibility(
  preferences: TodayUtilityPreferences,
  availableWidth: number,
  detailOpen: boolean,
): TodayUtilityVisibility {
  if (!detailOpen) {
    return {
      plan: preferences.planOpen,
      notifications: preferences.notificationsOpen,
      constrainedDetail: false,
    };
  }

  if (availableWidth < TODAY_DETAIL_PANEL_MIN_WIDTH) {
    return {
      plan: false,
      notifications: false,
      constrainedDetail: true,
    };
  }

  if (preferences.planOpen && preferences.notificationsOpen) {
    return {
      plan: preferences.activePanel === 'plan',
      notifications: preferences.activePanel === 'notifications',
      constrainedDetail: false,
    };
  }

  return {
    plan: preferences.planOpen,
    notifications: preferences.notificationsOpen,
    constrainedDetail: false,
  };
}
