import { build } from 'esbuild';
import path from 'node:path';
import { assertSyncWorkerArtifactFile } from './assert-sync-worker-artifact.mjs';
import { syncWorkerExternalPackages } from './lib/sync-worker-dependencies.mjs';

const root = process.cwd();

await build({
  entryPoints: [path.join(root, 'src', 'sync-worker.ts')],
  outfile: path.join(root, 'dist', 'sync-worker.cjs'),
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

await assertSyncWorkerArtifactFile(path.join(root, 'dist', 'sync-worker.cjs'));
