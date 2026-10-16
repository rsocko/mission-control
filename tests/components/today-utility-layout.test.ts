import { describe, expect, it } from 'vitest';
import {
  TODAY_DETAIL_PANEL_MIN_WIDTH,
  TODAY_DUAL_PANEL_MIN_WIDTH,
  resolveTodayUtilityLayout,
} from '@/components/today/today-utility-layout';

describe('My Day utility layout', () => {
  it('shows both utility panels only when the workspace is wide enough', () => {
    expect(resolveTodayUtilityLayout(TODAY_DUAL_PANEL_MIN_WIDTH - 1, false)).toBe('single');
    expect(resolveTodayUtilityLayout(TODAY_DUAL_PANEL_MIN_WIDTH, false)).toBe('dual');
  });

  it('keeps one utility panel beside task detail on wide workspaces', () => {
    expect(resolveTodayUtilityLayout(TODAY_DETAIL_PANEL_MIN_WIDTH - 1, true)).toBe('rail');
    expect(resolveTodayUtilityLayout(TODAY_DETAIL_PANEL_MIN_WIDTH, true)).toBe('detail-single');
  });
});
