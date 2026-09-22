import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('mobile viewport shell contract', () => {
  it('uses a dynamic viewport with a legacy fallback and internal scrolling', () => {
    const styles = readSource('src/app/globals.css');
    const shell = readSource('src/components/layout/AppShell.tsx');

    expect(styles).toMatch(
      /\.app-viewport\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s,
    );
    expect(shell).toContain('className="app-viewport flex bg-[var(--background)]"');
    expect(shell).toContain(
      'className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--background)]"',
    );
    expect(shell).not.toContain('pb-[calc(3.5rem+var(--safe-area-inset-bottom)+1px)]');
  });

  it('assigns each shell safe area to exactly one chrome component', () => {
    const header = readSource('src/components/layout/MobileHeader.tsx');
    const nav = readSource('src/components/layout/MobileBottomNav.tsx');
    const triage = readSource('src/components/triage/mobile/MobileTriageStream.tsx');

    expect(header.match(/\bsafe-area-pt\b/g)).toHaveLength(1);
    expect(nav.match(/\bsafe-area-pb\b/g)).toHaveLength(1);
    expect(triage).not.toContain('env(safe-area-inset-top)');
    expect(triage).not.toContain('env(safe-area-inset-bottom)');
  });

  it('uses legible edge-to-edge PWA chrome and disables native automatic insets', () => {
    const layout = readSource('src/app/layout.tsx');
    const webViewController = readSource(
      'ios/MissionControl/Web/WebViewController.swift',
    );

    expect(layout).toContain('statusBarStyle: "black-translucent"');
    expect(webViewController).toContain(
      'webView.scrollView.contentInsetAdjustmentBehavior = .never',
    );
    expect(webViewController).toContain(
      'webView.scrollView.automaticallyAdjustsScrollIndicatorInsets = false',
    );
  });
});
