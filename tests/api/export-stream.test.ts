import { describe, expect, it, vi } from 'vitest';
import {
  createExportStream,
  ExportAdmissionController,
  type ExportLimits,
  type ExportResult,
  type ExportSource,
} from '@/lib/export-stream';

const limits: ExportLimits = {
  batchSize: 2,
  maxBytes: 1_000_000,
  maxDurationMs: 5_000,
  maxRecords: 10_000,
};

function source(name: string, rows: Record<string, unknown>[]): ExportSource {
  return {
    name,
    readPage: vi.fn(async (cursor, limit) => {
      const offset = typeof cursor === 'number' ? cursor : 0;
      const records = rows.slice(offset, offset + limit);
      return {
        records,
        nextCursor: records.length === limit ? offset + records.length : undefined,
      };
    }),
  };
}

function streamOptions(
  sources: ExportSource[],
  overrides: Partial<Parameters<typeof createExportStream>[0]> = {},
) {
  const controller = new AbortController();
  const onFinish = vi.fn<(result: ExportResult) => void>();
  return {
    controller,
    onFinish,
    options: {
      exportedAt: '2026-08-07T00:00:00.000Z',
      format: 'json' as const,
      limits,
      onFinish,
      requestSignal: controller.signal,
      sources,
      ...overrides,
    },
  };
}

describe('bounded export stream', () => {
  it('streams empty JSON with the compatible schema', async () => {
    const tasks = source('tasks', []);
    const { onFinish, options } = streamOptions([tasks]);

    const body = await new Response(createExportStream(options)).json();

    expect(body).toEqual({
      exportedAt: '2026-08-07T00:00:00.000Z',
      version: '1.0',
      tasks: [],
    });
    expect(tasks.readPage).toHaveBeenCalledWith(undefined, 2, expect.any(AbortSignal));
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'completed',
      records: 0,
    }));
  });

  it('reads large exports incrementally in bounded pages', async () => {
    const rows = Array.from({ length: 7 }, (_, id) => ({ id, title: `Task ${id}` }));
    const tasks = source('tasks', rows);
    const { onFinish, options } = streamOptions([tasks]);

    const body = await new Response(createExportStream(options)).json();

    expect(body.tasks).toEqual(rows);
    expect(tasks.readPage).toHaveBeenCalledTimes(4);
    expect(tasks.readPage).toHaveBeenNthCalledWith(1, undefined, 2, expect.any(AbortSignal));
    expect(tasks.readPage).toHaveBeenNthCalledWith(4, 6, 2, expect.any(AbortSignal));
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'completed',
      records: 7,
    }));
  });

  it('terminates when the byte budget is exceeded', async () => {
    const tasks = source('tasks', [{ id: '1', title: 'larger than the budget' }]);
    const { onFinish, options } = streamOptions([tasks], {
      limits: { ...limits, maxBytes: 100 },
    });

    await expect(new Response(createExportStream(options)).text())
      .rejects.toThrow('Export byte limit exceeded');
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'byte_limit',
      outcome: 'failed',
      records: 0,
    }));
  });

  it('terminates before emitting a record beyond the record budget', async () => {
    const tasks = source('tasks', [{ id: '1' }, { id: '2' }]);
    const { onFinish, options } = streamOptions([tasks], {
      limits: { ...limits, maxRecords: 1 },
    });

    await expect(new Response(createExportStream(options)).text())
      .rejects.toThrow('Export record limit exceeded');
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'record_limit',
      outcome: 'failed',
      records: 1,
    }));
  });

  it('aborts stalled reads when the duration budget expires', async () => {
    const tasks: ExportSource = {
      name: 'tasks',
      readPage: vi.fn((_cursor, _limit, signal) => new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })),
    };
    const { onFinish, options } = streamOptions([tasks], {
      limits: { ...limits, maxDurationMs: 10 },
    });

    await expect(new Response(createExportStream(options)).text())
      .rejects.toThrow('Export duration limit exceeded');
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'duration_limit',
      outcome: 'failed',
    }));
  });

  it('aborts pending database work when the requester disconnects', async () => {
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const tasks: ExportSource = {
      name: 'tasks',
      readPage: vi.fn((_cursor, _limit, signal) => new Promise<never>((_, reject) => {
        readStarted();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })),
    };
    const { controller, onFinish, options } = streamOptions([tasks]);
    const reading = new Response(createExportStream(options)).text();

    await started;
    controller.abort();

    await expect(reading).rejects.toThrow('Export cancelled');
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'cancelled',
      outcome: 'cancelled',
    }));
  });

  it('cleans up immediately when an idle requester disconnects', async () => {
    const { controller, onFinish, options } = streamOptions([]);
    createExportStream(options);

    controller.abort();
    await vi.waitFor(() => {
      expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'cancelled',
        outcome: 'cancelled',
      }));
    });
  });

  it('reports serialization failures and releases the stream', async () => {
    const circular: Record<string, unknown> = { id: '1' };
    circular.self = circular;
    const { onFinish, options } = streamOptions([source('tasks', [circular])]);

    await expect(new Response(createExportStream(options)).text())
      .rejects.toThrow('A record could not be serialized as JSON');
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'serialization_error',
      outcome: 'failed',
    }));
  });

  it('bounds concurrency, rejects duplicates, and permits work after cleanup', () => {
    const admission = new ExportAdmissionController(2);
    const first = admission.acquire('requester:json:all');
    expect(first.acquired).toBe(true);
    expect(admission.acquire('requester:json:all')).toEqual({
      acquired: false,
      reason: 'duplicate',
    });
    expect(admission.acquire('other:json:all').acquired).toBe(true);
    expect(admission.acquire('third:json:all')).toEqual({
      acquired: false,
      reason: 'capacity',
    });

    if (first.acquired) first.release();
    expect(admission.acquire('requester:json:all').acquired).toBe(true);
  });
});
