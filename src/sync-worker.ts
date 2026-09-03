import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPackagedSyncWorker } from '@/lib/runtime/packaged-sync-worker';

process.env.MC_PROCESS_ROLE = 'worker';

void runPackagedSyncWorker().catch((error) => {
  rmSync(
    process.env.MC_WORKER_INSTANCE_FILE
      ?? join(tmpdir(), 'mission-control-worker-instance'),
    { force: true },
  );
  console.error('Sync worker failed to start', error);
  process.exit(1);
});
