export type TodayUtilityLayout = 'dual' | 'single' | 'detail-single' | 'rail';

export const TODAY_DUAL_PANEL_MIN_WIDTH = 1320;
export const TODAY_DETAIL_PANEL_MIN_WIDTH = 1320;

export function resolveTodayUtilityLayout(
  availableWidth: number,
  detailOpen: boolean,
): TodayUtilityLayout {
  if (detailOpen) {
    return availableWidth >= TODAY_DETAIL_PANEL_MIN_WIDTH ? 'detail-single' : 'rail';
  }

  return availableWidth >= TODAY_DUAL_PANEL_MIN_WIDTH ? 'dual' : 'single';
}
