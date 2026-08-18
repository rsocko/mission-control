import { cp } from 'node:fs/promises';
import path from 'node:path';
import { packageSyncWorkerRuntime } from '../package-sync-worker-runtime.mjs';

export async function stageSyncWorkerRuntime({
  root,
  runtimeRoot,
  packagedRuntime,
  copy = cp,
  packageRuntime = packageSyncWorkerRuntime,
}) {
  if (packagedRuntime) {
    await copy(packagedRuntime, runtimeRoot, { recursive: true, dereference: true });
  } else {
    await packageRuntime(runtimeRoot);
  }

  // A standalone Next trace can contain broad repository paths. Overlay these
  // runtime-owned trees only after that copy completes so recursive copies
  // never mutate the same destination concurrently.
  await copy(path.join(root, 'dist'), path.join(runtimeRoot, 'dist'), { recursive: true });
  await copy(path.join(root, 'drizzle'), path.join(runtimeRoot, 'drizzle'), { recursive: true });
}
