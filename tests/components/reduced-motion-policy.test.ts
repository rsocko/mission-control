import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const globalCss = readSource('src/app/globals.css');
const layoutSource = readSource('src/app/layout.tsx');
const motionProviderSource = readSource('src/components/providers/AppMotionProvider.tsx');
const homePageSource = readSource('src/app/page.tsx');
const tooltipSource = readSource('src/components/ui/Tooltip.tsx');
const effortBadgeSource = readSource('src/components/EffortBadge.tsx');
const durationPickerSource = readSource(
  'src/components/task-detail/DurationPicker.tsx',
);
const pullToRefreshSource = readSource('src/lib/hooks/usePullToRefresh.ts');
const mobileTriageEmptySource = readSource(
  'src/components/triage/mobile/MobileTriageEmpty.tsx',
);

describe('reduced motion policy', () => {
  it('does not use a blanket magic duration override', () => {
    expect(globalCss).not.toContain('animation-duration: 0.01ms');
    expect(globalCss).not.toContain('animation-iteration-count: 1');
    expect(globalCss).not.toContain('transition-duration: 0.01ms');
    expect(globalCss).not.toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\*\s*,\s*\*::before/,
    );
  });

  it('suppresses continuous and spatial CSS motion while preserving feedback', () => {
    expect(globalCss).toContain('[class*="animate-spin"]');
    expect(globalCss).toContain('.refresh-progress-indicator');
    expect(globalCss).toContain('transition-property: color, background-color, border-color, opacity, box-shadow');
    expect(globalCss).toContain('[class*="transition-transform"]');
    expect(globalCss).toContain('[class*="transition-["][class*="width"]');
    expect(globalCss).toContain('[class*="after:transition-transform"]::after');
    expect(globalCss).toContain('.motion-tooltip');
    expect(globalCss).toContain('.linked-field-feedback');
    expect(globalCss).toContain('animation-name: fade-in');
  });

  it('configures Motion to honor the user preference across the app', () => {
    expect(motionProviderSource).toContain('<MotionConfig reducedMotion="user">');
    expect(layoutSource).toContain('<AppMotionProvider>');
    expect(layoutSource).toContain('</AppMotionProvider>');
  });

  it('keeps refresh and mobile empty-state feedback visible without spatial motion', () => {
    expect(homePageSource).toContain('refresh-progress-indicator');
    expect(homePageSource).not.toContain('animate-[shimmer_');
    expect(mobileTriageEmptySource).toContain('mobile-triage-empty-content');
    expect(globalCss).toMatch(
      /\.refresh-progress-indicator\s*\{\s*width: 100%;\s*\}/,
    );
    expect(globalCss).toMatch(
      /\.mobile-triage-empty-content\s*\{[\s\S]*?animation-name: fade-in/,
    );
  });

  it('marks tooltip and linked-field feedback for non-spatial alternatives', () => {
    expect(tooltipSource).toContain('motion-tooltip');
    expect(effortBadgeSource).toContain('linked-field-feedback');
    expect(durationPickerSource).toContain('linked-field-feedback');
    expect(globalCss).toMatch(
      /\.linked-field-feedback\s*\{[\s\S]*?transform: none !important/,
    );
    expect(pullToRefreshSource).toContain('usePrefersReducedMotion()');
    expect(pullToRefreshSource).toContain(
      "prefersReducedMotion ? 'none' : 'transform 0.2s ease-out'",
    );
  });
});
