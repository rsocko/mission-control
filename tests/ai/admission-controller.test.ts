import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIAdmissionRejectedError,
  acquireOllamaAdmission,
  resetAIAdmissionControllerForTests,
} from '@/lib/ai/admission-controller';

describe('Ollama admission controller', () => {
  beforeEach(() => {
    vi.stubEnv('MC_AI_OLLAMA_CONCURRENCY', '1');
    vi.stubEnv('MC_AI_OLLAMA_QUEUE_LENGTH', '1');
    resetAIAdmissionControllerForTests();
  });

  afterEach(() => {
    resetAIAdmissionControllerForTests();
    vi.unstubAllEnvs();
  });

  it('rejects explicitly when concurrency and queue capacity are exhausted', async () => {
    const active = await acquireOllamaAdmission();
    const queuedPromise = acquireOllamaAdmission();

    await expect(acquireOllamaAdmission()).rejects.toBeInstanceOf(AIAdmissionRejectedError);

    active.release();
    const queued = await queuedPromise;
    queued.release();
  });

  it('removes cancelled requests from the queue and releases capacity', async () => {
    const active = await acquireOllamaAdmission();
    const controller = new AbortController();
    const queuedPromise = acquireOllamaAdmission(controller.signal);
    controller.abort(new Error('client disconnected'));

    await expect(queuedPromise).rejects.toThrow('client disconnected');
    active.release();

    const replacement = await acquireOllamaAdmission();
    replacement.release();
  });

  it('makes release idempotent after provider failures', async () => {
    const active = await acquireOllamaAdmission();
    active.release();
    active.release();

    const replacement = await acquireOllamaAdmission();
    replacement.release();
  });
});
