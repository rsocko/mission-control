import { runWithConnectorOperationLease } from '../../../src/lib/sync/connector-lock';

const [connectorId, leaseMsValue, mode] = process.argv.slice(2);
const leaseMs = Number(leaseMsValue);
if (!connectorId || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
  throw new Error('connectorId and a positive leaseMs are required');
}
if (!process.send) throw new Error('Connector lock fixture requires an IPC channel');
process.env.MC_CONNECTOR_OPERATION_LEASE_MS = String(leaseMs);

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  try {
    await runWithConnectorOperationLease(connectorId, 'retention', async () => {
      await send({ acquired: true });
      if (mode === 'crash') process.exit(0);
      await new Promise<void>((resolve, reject) => {
        process.once('message', (message) => {
          if (message !== 'release') {
            reject(new Error(`Unexpected fixture message: ${String(message)}`));
            return;
          }
          resolve();
        });
      });
    });
    await send({ released: true });
    process.exit(0);
  } catch (error) {
    await send({
      acquired: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(0);
  }
}

void main();
