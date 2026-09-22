import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const searchCommand = readFileSync(
  resolve(process.cwd(), 'src/components/search/SearchCommand.tsx'),
  'utf8',
);

describe('search close control', () => {
  it('provides an accessible mouse control beside the escape hint', () => {
    expect(searchCommand).toMatch(
      /<kbd[\s\S]*?ESC[\s\S]*?<\/kbd>\s*<Dialog\.Close asChild>[\s\S]*?aria-label="Close search"[\s\S]*?<X size=\{16\} \/>/,
    );
  });
});
