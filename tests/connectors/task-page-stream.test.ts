import { describe, expect, it, vi } from 'vitest';
import { mergeAsyncStreams } from '@/lib/connectors/task-page-stream';

describe('mergeAsyncStreams', () => {
  it('starts streams concurrently and keeps at most one page prefetched per stream', async () => {
    const events: string[] = [];
    let releaseSecondPage: (() => void) | undefined;
    const secondPageReady = new Promise<void>(resolve => {
      releaseSecondPage = resolve;
    });

    async function* stream(name: string) {
      events.push(`${name}:first-requested`);
      yield `${name}:first`;
      events.push(`${name}:second-requested`);
      await secondPageReady;
      yield `${name}:second`;
    }

    const iterator = mergeAsyncStreams([stream('one'), stream('two')], 2);
    const first = await iterator.next();

    expect(first.value).toMatch(/^(one|two):first$/);
    expect(events).toEqual(expect.arrayContaining([
      'one:first-requested',
      'two:first-requested',
      `${String(first.value).split(':')[0]}:second-requested`,
    ]));

    releaseSecondPage?.();
    const remaining = (await Array.fromAsync(iterator)).sort();
    expect([first.value, ...remaining].sort()).toEqual([
      'one:first',
      'one:second',
      'two:first',
      'two:second',
    ]);
  });

  it('starts only the configured number of streams', async () => {
    const started: string[] = [];

    async function* stream(name: string) {
      started.push(name);
      yield name;
    }

    const iterator = mergeAsyncStreams(
      [stream('one'), stream('two'), stream('three')],
      2,
    );
    await iterator.next();

    expect(started).toHaveLength(2);
    await iterator.return();
  });

  it('closes active streams and leaves queued streams idle after an error', async () => {
    const started: string[] = [];
    let activeClosed = false;
    let queuedStarted = false;
    let rejectFailure!: (error: Error) => void;
    let releaseActive!: () => void;
    const failure = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    const activePage = new Promise<void>(resolve => {
      releaseActive = resolve;
    });

    async function* failingStream() {
      started.push('failing');
      await failure;
      yield 'unreachable';
    }

    async function* activeStream() {
      started.push('active');
      try {
        await activePage;
        yield 'active';
      } finally {
        activeClosed = true;
      }
    }

    async function* queuedStream() {
      queuedStarted = true;
      yield 'queued';
    }

    const iterator = mergeAsyncStreams(
      [failingStream(), activeStream(), queuedStream()],
      2,
    );
    const firstPage = iterator.next();
    await vi.waitFor(() => expect(started).toHaveLength(2));

    setTimeout(releaseActive, 0);
    rejectFailure(new Error('stream failed'));

    await expect(firstPage).rejects.toThrow('stream failed');
    expect(activeClosed).toBe(true);
    expect(queuedStarted).toBe(false);
  });
});
