type StreamResult<T> =
  | { streamId: number; result: IteratorResult<T>; error?: never }
  | { streamId: number; result?: never; error: unknown };

/**
 * Merge async streams while keeping at most one page buffered per active stream.
 */
export async function* mergeAsyncStreams<T>(
  streams: AsyncIterable<T>[],
  concurrency: number,
): AsyncGenerator<T, void, unknown> {
  const maxConcurrency = Math.max(1, concurrency);
  const active = new Map<number, AsyncIterator<T>>();
  const pending = new Map<number, Promise<StreamResult<T>>>();
  let nextStreamId = 0;

  const requestNext = (streamId: number, iterator: AsyncIterator<T>) => {
    const request: Promise<StreamResult<T>> = iterator.next().then(
      result => ({ streamId, result }),
      error => ({ streamId, error }),
    );
    pending.set(
      streamId,
      request,
    );
  };

  const activateStreams = () => {
    while (active.size < maxConcurrency && nextStreamId < streams.length) {
      const streamId = nextStreamId++;
      const iterator = streams[streamId][Symbol.asyncIterator]();
      active.set(streamId, iterator);
      requestNext(streamId, iterator);
    }
  };

  activateStreams();

  try {
    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.streamId);

      if ('error' in settled) {
        throw settled.error;
      }

      const iterator = active.get(settled.streamId);
      if (!iterator) continue;

      if (settled.result.done) {
        active.delete(settled.streamId);
        activateStreams();
        continue;
      }

      requestNext(settled.streamId, iterator);
      yield settled.result.value;
    }
  } finally {
    const closeRequests = Array.from(active.values(), iterator => iterator.return?.());
    await Promise.allSettled([...pending.values(), ...closeRequests]);
  }
}
