import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function findNativeSelects(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findNativeSelects(path);
    if (!entry.name.endsWith('.tsx')) return [];
    return /<select\b/.test(readFileSync(path, 'utf8'))
      ? [relative(process.cwd(), path)]
      : [];
  });
}

describe('dropdown consistency', () => {
  it('uses the shared Radix controls instead of native selects', () => {
    expect(findNativeSelects(join(process.cwd(), 'src'))).toEqual([]);
  });
});
