export class ConnectorOperationBusyError extends Error {
  constructor(message = 'Another operation is already queued or in progress for this connector') {
    super(message);
    this.name = 'ConnectorOperationBusyError';
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getConnectorOperationLeaseMs(): number {
  return positiveInteger(process.env.MC_CONNECTOR_OPERATION_LEASE_MS, 120_000);
}

export function connectorSyncLeaseOwner(jobId: string, workerOwner: string): string {
  return `sync:${jobId}:${workerOwner}`;
}
