import type { IConnector } from '@/lib/connectors';

const DEFAULT_DEPENDENCY_SNAPSHOT_TIMEOUT_MS = 4 * 60 * 1000;

function getDependencySnapshotTimeoutMs(): number {
  const configured = Number(process.env.MC_DEPENDENCY_SNAPSHOT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_DEPENDENCY_SNAPSHOT_TIMEOUT_MS;
}

export async function fetchDependencySnapshot(
  connector: IConnector,
  sourceIds: string[],
) {
  if (!connector.fetchTaskDependencies) {
    throw new Error('Connector cannot read task dependencies');
  }

  const timeoutMs = getDependencySnapshotTimeoutMs();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Dependency snapshot timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      connector.fetchTaskDependencies(sourceIds, { signal: controller.signal }),
      timeoutResult,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
