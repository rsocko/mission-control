import { build } from 'esbuild';
import path from 'node:path';
import { assertSyncWorkerArtifactFile } from './assert-sync-worker-artifact.mjs';
import { syncWorkerExternalPackages } from './lib/sync-worker-dependencies.mjs';

const root = process.cwd();

for (const [entry, output] of [
  ['sync-worker.ts', 'sync-worker.cjs'],
  ['sync-worker-integration.ts', 'sync-worker-integration.cjs'],
  ['sync-worker-healthcheck.ts', 'sync-worker-healthcheck.cjs'],
  ['semantic-worker-harness.ts', 'semantic-worker-harness.cjs'],
]) {
  await build({
    entryPoints: [path.join(root, 'src', entry)],
    outfile: path.join(root, 'dist', output),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'bundle',
    external: syncWorkerExternalPackages,
    alias: {
      '@': path.join(root, 'src'),
    },
    conditions: ['react-server', 'node'],
    sourcemap: true,
    logLevel: 'info',
  });
}

await assertSyncWorkerArtifactFile(path.join(root, 'dist', 'sync-worker.cjs'));
