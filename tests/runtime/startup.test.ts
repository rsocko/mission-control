import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateFailedStartup } from '@/lib/runtime/startup';

describe('startup termination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('schedules a nonzero exit before rethrowing the startup error', async () => {
    const error = new Error('startup failed');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    expect(() => terminateFailedStartup(error)).toThrow(error);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(process.exitCode).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
