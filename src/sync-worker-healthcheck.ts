import {
  runWorkerHealthcheck,
  WorkerHealthcheckError,
} from '@/lib/runtime/worker-healthcheck';

void runWorkerHealthcheck().catch((error) => {
  const message = error instanceof WorkerHealthcheckError
    ? error.message
    : 'unexpected worker healthcheck failure';
  console.error(`Sync worker healthcheck failed: ${message}`);
  process.exitCode = 1;
});
