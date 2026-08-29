import {
  quarantineFinanceConnectorSync,
} from '../../../src/lib/sync/operator-control';
import { enqueueSyncJob } from '../../../src/lib/sync/job-queue';

const [connectorId, action] = process.argv.slice(2);
if (!connectorId || !action || !process.send) {
  throw new Error('connectorId, action, and IPC are required');
}

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  await send({ ready: true });
  await new Promise<void>((resolve) => process.once('message', () => resolve()));
  try {
    if (action === 'quarantine') {
      quarantineFinanceConnectorSync({
        connectorId,
        actorType: 'service',
        idempotencyKey: 'finance-race-quarantine-key',
      });
    } else if (action === 'enqueue') {
      enqueueSyncJob(connectorId, { source: 'schedule' });
    } else {
      throw new Error('unsupported_action');
    }
    await send({ action, status: 'succeeded' });
  } catch (error) {
    await send({
      action,
      status: 'failed',
      code: error instanceof Error && 'code' in error
        ? String(error.code)
        : 'operator_race_failed',
    });
  }
  process.exit(0);
}

void main();
