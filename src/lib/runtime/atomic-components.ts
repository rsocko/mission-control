export interface AtomicWorkerComponent {
  name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface StartedAtomicWorker {
  readonly componentNames: readonly string[];
  stop(): Promise<void>;
}

export const PACKAGED_SYNC_WORKER_COMPONENT_ORDER = Object.freeze([
  'runtime-telemetry',
  'sync-claim-worker',
  'durable-ai',
  'task-reminders',
  'event-outbox',
  'notification-enrichment',
  'sync-schedulers',
  'finance-recovery',
  'triage-scheduler',
  'semantic-index',
  'houston-memory-retention',
  'worker-health-snapshots',
  'postgres-workflow-capability',
] as const);

export function assertAtomicWorkerComponentOrder(
  components: readonly AtomicWorkerComponent[],
  expected: readonly string[],
): void {
  const actual = components.map(({ name }) => name);
  if (
    actual.length !== expected.length
    || expected.some((name, index) => actual[index] !== name)
  ) {
    throw new Error(
      `Packaged worker component order is incomplete: expected ${expected.join(', ')}`,
    );
  }
}

async function stopComponents(
  components: readonly AtomicWorkerComponent[],
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const component of [...components].reverse()) {
    try {
      await component.stop();
    } catch (error) {
      failures.push(new Error(
        `Failed to stop packaged worker component "${component.name}"`,
        { cause: error },
      ));
    }
  }
  return failures;
}

/**
 * Starts the packaged worker as one lifecycle transaction. A failing component
 * is stopped defensively before all prior components are unwound in reverse.
 */
export async function startAtomicWorkerComponents(
  components: readonly AtomicWorkerComponent[],
  signal?: AbortSignal,
): Promise<StartedAtomicWorker> {
  const names = new Set<string>();
  for (const component of components) {
    if (!component.name.trim() || names.has(component.name)) {
      throw new Error(`Invalid or duplicate worker component name "${component.name}"`);
    }
    names.add(component.name);
  }

  const started: AtomicWorkerComponent[] = [];
  for (const component of components) {
    try {
      signal?.throwIfAborted();
      await component.start();
      started.push(component);
      signal?.throwIfAborted();
    } catch (startError) {
      const cleanupFailures = await stopComponents([
        ...started,
        ...(started.at(-1) === component ? [] : [component]),
      ]);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [startError, ...cleanupFailures],
          `Packaged worker failed while starting "${component.name}" and rollback was incomplete`,
        );
      }
      throw new Error(
        `Packaged worker failed while starting "${component.name}"`,
        { cause: startError },
      );
    }
  }

  let stopPromise: Promise<void> | null = null;
  return {
    componentNames: [...names],
    stop() {
      stopPromise ??= (async () => {
        const failures = await stopComponents(started);
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Packaged worker shutdown was incomplete',
          );
        }
      })();
      return stopPromise;
    },
  };
}
