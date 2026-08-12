import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shellFiles = [
  'src/components/layout/AppShell.tsx',
  'src/components/layout/MobileBottomNav.tsx',
];

describe('shared shell typography', () => {
  it.each(shellFiles)('%s keeps user-facing labels on the 11px minimum ramp', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');

    expect(source).not.toMatch(/text-\[(?:9|10)px\]/);
    expect(source).not.toMatch(/text-\[(?:0\.5625|0\.625)rem\]/);
  });
});
