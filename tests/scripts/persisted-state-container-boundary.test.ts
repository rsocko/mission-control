import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = process.cwd();
const GENERATOR_PATH = resolve(
  REPOSITORY_ROOT,
  'scripts',
  'generate-persisted-state-fixtures.ts',
);

function isWithin(directory: string, path: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
  );
}

describe('persisted-state fixture container boundary', () => {
  it('keeps generator imports inside the Docker build context', () => {
    const ignoredDirectories = readFileSync(
      resolve(REPOSITORY_ROOT, '.dockerignore'),
      'utf8',
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => (
        line
        && !line.startsWith('#')
        && !line.startsWith('!')
        && !/[*?[\]]/.test(line)
      ))
      .map((line) => resolve(REPOSITORY_ROOT, line));
    const generatorSource = readFileSync(GENERATOR_PATH, 'utf8');
    const relativeImports = Array.from(
      generatorSource.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
      (match) => resolve(dirname(GENERATOR_PATH), match[1]),
    );

    expect(ignoredDirectories).toContain(resolve(REPOSITORY_ROOT, 'tests'));
    for (const importedPath of relativeImports) {
      expect(
        ignoredDirectories.some((directory) => isWithin(directory, importedPath)),
        `Expected ${relative(REPOSITORY_ROOT, importedPath)} to be in the Docker context`,
      ).toBe(false);
    }
  });
});
