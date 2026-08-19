import { describe, expect, it } from 'vitest';
import {
  syncWorkerExternalPackages,
  syncWorkerRequiredArtifacts,
  syncWorkerRequiredNativeArtifacts,
  syncWorkerSupplementalPackages,
} from '../../scripts/lib/sync-worker-dependencies.mjs';

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
      'node_modules/node-cron/dist/tasks/background-scheduled-task/daemon.js',
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
});
