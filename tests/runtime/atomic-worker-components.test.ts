import { describe, expect, it, vi } from 'vitest';
import {
  assertAtomicWorkerComponentOrder,
  PACKAGED_SYNC_WORKER_COMPONENT_ORDER,
  startAtomicWorkerComponents,
  type AtomicWorkerComponent,
} from '@/lib/runtime/atomic-components';

function component(
  name: string,
  events: string[],
  start: () => void | Promise<void> = () => {},
  stop: () => void | Promise<void> = () => {},
): AtomicWorkerComponent {
  return {
    name,
    async start() {
      events.push(`start:${name}`);
      await start();
    },
    async stop() {
      events.push(`stop:${name}`);
      await stop();
    },
  };
}

describe('packaged worker atomic lifecycle', () => {
  it.each(PACKAGED_SYNC_WORKER_COMPONENT_ORDER.map((name, index) => [name, index] as const))(
    'rolls back in strict reverse order when packaged boundary %s fails',
    async (_name, failureIndex) => {
      const events: string[] = [];
      const components = PACKAGED_SYNC_WORKER_COMPONENT_ORDER.map((name, index) =>
        component(name, events, () => {
          if (index === failureIndex) throw new Error(`failure-${index}`);
        })
      );

      await expect(startAtomicWorkerComponents(components))
        .rejects.toThrow(
          `failed while starting "${PACKAGED_SYNC_WORKER_COMPONENT_ORDER[failureIndex]}"`,
        );
      expect(events).toEqual([
        ...PACKAGED_SYNC_WORKER_COMPONENT_ORDER
          .slice(0, failureIndex + 1)
          .map((name) => `start:${name}`),
        ...PACKAGED_SYNC_WORKER_COMPONENT_ORDER
          .slice(0, failureIndex + 1)
          .reverse()
          .map((name) => `stop:${name}`),
      ]);
    },
  );

  it('rejects a missing or reordered packaged component before startup', () => {
    const components = PACKAGED_SYNC_WORKER_COMPONENT_ORDER.map((name) =>
      component(name, [])
    );
    expect(() => assertAtomicWorkerComponentOrder(
      components.slice(1),
      PACKAGED_SYNC_WORKER_COMPONENT_ORDER,
    )).toThrow(/component order is incomplete/);
    expect(() => assertAtomicWorkerComponentOrder(
      [components[1], components[0], ...components.slice(2)],
      PACKAGED_SYNC_WORKER_COMPONENT_ORDER,
    )).toThrow(/component order is incomplete/);
  });

  it('surfaces stop failures after attempting every reverse-order cleanup', async () => {
    const events: string[] = [];
    const runtime = await startAtomicWorkerComponents([
      component('first', events, undefined, () => {
        throw new Error('first-stop-failed');
      }),
      component('second', events, undefined, () => {
        throw new Error('second-stop-failed');
      }),
    ]);

    await expect(runtime.stop()).rejects.toThrow('shutdown was incomplete');
    expect(events.slice(-2)).toEqual(['stop:second', 'stop:first']);
  });

  it('deduplicates concurrent shutdown calls', async () => {
    const stop = vi.fn(async () => {});
    const runtime = await startAtomicWorkerComponents([
      component('only', [], undefined, stop),
    ]);

    await Promise.all([runtime.stop(), runtime.stop(), runtime.stop()]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('cancels startup and defensively stops the boundary that observed abort', async () => {
    const events: string[] = [];
    const abort = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starting = startAtomicWorkerComponents([
      component('first', events),
      component('second', events, () => blocked),
      component('never', events),
    ], abort.signal);

    await vi.waitFor(() => expect(events).toContain('start:second'));
    abort.abort(new Error('startup-cancelled'));
    release();

    await expect(starting).rejects.toThrow('failed while starting "second"');
    expect(events).toEqual([
      'start:first',
      'start:second',
      'stop:second',
      'stop:first',
    ]);
  });
});
