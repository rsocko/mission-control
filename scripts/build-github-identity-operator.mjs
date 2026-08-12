import { build } from 'esbuild';
import path from 'node:path';

const root = process.cwd();

await build({
  entryPoints: [path.join(root, 'scripts', 'github-identity-operator.ts')],
  outfile: path.join(root, 'dist', 'github-identity-operator.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'bundle',
  external: ['better-sqlite3'],
  alias: {
    '@': path.join(root, 'src'),
  },
  conditions: ['react-server', 'node'],
  sourcemap: true,
  logLevel: 'info',
});
