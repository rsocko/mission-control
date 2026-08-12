import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('demo mode banner layout', () => {
  it('keeps the banner at the top of the content column', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/layout/AppShell.tsx'),
      'utf8',
    );
    const contentColumn = source.indexOf(
      '<div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">',
    );
    const banner = source.indexOf('<DemoModeBanner />');
    const mobileHeader = source.indexOf('<MobileHeader');

    expect(contentColumn).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(contentColumn);
    expect(banner).toBeLessThan(mobileHeader);
  });

  it('stacks banner content on narrow screens', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/DemoModeBanner.tsx'),
      'utf8',
    );

    expect(source).toContain('flex-col');
    expect(source).toContain('sm:flex-row');
  });
});
