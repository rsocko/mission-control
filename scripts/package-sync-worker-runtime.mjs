import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';
import {
  syncWorkerRequiredArtifacts,
  syncWorkerRequiredNativeArtifacts,
  syncWorkerSupplementalPackages,
} from './lib/sync-worker-dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const workerEntry = path.join(root, 'dist', 'sync-worker.cjs');
const identityOperatorEntry = path.join(root, 'dist', 'github-identity-operator.cjs');
const defaultStandaloneDir = path.join(root, '.next', 'standalone');
const supplementalEntries = syncWorkerSupplementalPackages.map((packageName) =>
  path.relative(root, require.resolve(packageName)),
);

function normalize(file) {
  return file.split(path.sep).join('/');
}

function validateTrace(fileList, warnings) {
  const files = new Set([...fileList].map(normalize));
  const missing = syncWorkerRequiredArtifacts.filter((file) => !files.has(file));
  for (const pattern of syncWorkerRequiredNativeArtifacts) {
    if (![...files].some((file) => pattern.test(file))) missing.push(pattern.toString());
  }
  if (missing.length > 0) {
    throw new Error(`Worker runtime trace omitted required artifacts:\n${missing.join('\n')}`);
  }

  const unexpectedWarnings = [...warnings].filter((warning) => {
    const message = warning instanceof Error ? warning.message : String(warning);
    return !message.includes('Failed to resolve dependency "canvas"')
      || !/node_modules[\\/]+jsdom[\\/]+/.test(message);
  });
  if (unexpectedWarnings.length > 0) {
    throw new AggregateError(unexpectedWarnings, 'Worker runtime dependency tracing failed');
  }
}

async function copyFiles(files, destination) {
  const queue = [...files];
  const destinationRoot = `${path.resolve(destination)}${path.sep}`;
  const workers = Array.from({ length: Math.min(32, queue.length) }, async () => {
    while (queue.length > 0) {
      const relativePath = queue.pop();
      if (!relativePath) return;
      const normalizedPath = normalize(relativePath);
      if (!normalizedPath.startsWith('node_modules/')) continue;
      const source = path.join(root, relativePath);
      const target = path.resolve(destination, relativePath);
      if (!target.startsWith(destinationRoot)) {
        throw new Error(`Worker runtime trace escaped its destination: ${relativePath}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  });
  await Promise.all(workers);
}

export async function packageSyncWorkerRuntime(standaloneDir = defaultStandaloneDir) {
  const { fileList, warnings } = await nodeFileTrace([
    workerEntry,
    identityOperatorEntry,
    ...supplementalEntries,
  ], {
    base: root,
    processCwd: root,
  });
  validateTrace(fileList, warnings);
  await mkdir(standaloneDir, { recursive: true });
  await copyFiles(fileList, standaloneDir);
  return [...fileList].filter((file) => normalize(file).startsWith('node_modules/')).length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fileCount = await packageSyncWorkerRuntime(
    process.env.MC_STANDALONE_DIR
      ? path.resolve(process.env.MC_STANDALONE_DIR)
      : defaultStandaloneDir,
  );
  console.log(`Packaged ${fileCount} traced sync-worker runtime files`);
}
