import { describe, expect, it } from 'vitest';
import {
  syncWorkerExternalPackages,
  syncWorkerRequiredArtifacts,
  syncWorkerRequiredNativeArtifacts,
  syncWorkerSupplementalPackages,
} from '../../scripts/lib/sync-worker-dependencies.mjs';
import { readFileSync } from 'node:fs';

describe('sync worker dependency metadata', () => {
  it('keeps packaged dependencies aligned with esbuild externals', () => {
    for (const packageName of [
      'better-sqlite3',
      'metascraper',
      'node-cron',
      'pino',
      'pino-pretty',
      're2',
    ]) {
      expect(syncWorkerExternalPackages).toContain(packageName);
      expect(syncWorkerRequiredArtifacts).toContain(
        `node_modules/${packageName}/package.json`,
      );
    }
    expect(syncWorkerSupplementalPackages).toEqual(['pino-pretty']);
    expect(syncWorkerRequiredArtifacts).toContain(
      'node_modules/node-cron/dist/daemon.cjs',
    );
  });

  it('requires native binaries for every external native package', () => {
    expect(
      syncWorkerRequiredNativeArtifacts.some((pattern) =>
        pattern.test(
          'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        ),
      ),
    ).toBe(true);
    expect(
      syncWorkerRequiredNativeArtifacts.some((pattern) =>
        pattern.test('node_modules/re2/build/Release/re2.node'),
      ),
    ).toBe(true);
  });

  it('packages the gated semantic worker harness as a traced runtime entry', () => {
    const build = readFileSync('scripts/build-sync-worker.mjs', 'utf8');
    const packaging = readFileSync('scripts/package-sync-worker-runtime.mjs', 'utf8');
    expect(build).toContain("['semantic-worker-harness.ts', 'semantic-worker-harness.cjs']");
    expect(packaging).toContain('semanticWorkerHarnessEntry');
    expect(packaging).toContain('semantic-worker-harness.cjs');
  });

  it('builds the guarded whole-worker launcher beside the production bootstrap', () => {
    const build = readFileSync('scripts/build-sync-worker.mjs', 'utf8');
    expect(build).toContain("['sync-worker.ts', 'sync-worker.cjs']");
    expect(build).toContain(
      "['sync-worker-integration.ts', 'sync-worker-integration.cjs']",
    );
  });
});
