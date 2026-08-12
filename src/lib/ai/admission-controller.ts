import { aiLogger } from '@/lib/logger';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_LENGTH = 8;
const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_AFTER_SECONDS = 5;

interface AdmissionWaiter {
  enqueuedAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (admission: AIAdmission) => void;
  reject: (error: unknown) => void;
}

interface AdmissionState {
  active: number;
  queue: AdmissionWaiter[];
}

export interface AIAdmission {
  queueTimeMs: number;
  release: () => void;
}

const GLOBAL_KEY = '__mc_ai_admission__';
const admissionGlobal = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: AdmissionState;
};
const state = admissionGlobal[GLOBAL_KEY] ?? { active: 0, queue: [] };
admissionGlobal[GLOBAL_KEY] = state;

function readBoundedInteger(name: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function readBoundedQueueLength(): number {
  const parsed = Number.parseInt(process.env.MC_AI_OLLAMA_QUEUE_LENGTH ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, 100)
    : DEFAULT_QUEUE_LENGTH;
}

export function getAIAdmissionConfig() {
  return {
    concurrency: readBoundedInteger('MC_AI_OLLAMA_CONCURRENCY', DEFAULT_CONCURRENCY, 32),
    queueLength: readBoundedQueueLength(),
    timeoutMs: readBoundedInteger('MC_AI_PROVIDER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 15 * 60_000),
  };
}

export class AIAdmissionRejectedError extends Error {
  readonly code = 'AI_CAPACITY_EXHAUSTED';
  readonly status = 503;
  readonly retryAfter = RETRY_AFTER_SECONDS;

  constructor() {
    super('AI capacity is exhausted. Retry shortly.');
    this.name = 'AIAdmissionRejectedError';
  }
}

export function getAIOverloadDetails(error: unknown): {
  message: string;
  code: string;
  status: number;
  retryAfter: number;
} | null {
  if (!(error instanceof AIAdmissionRejectedError)) return null;
  return {
    message: error.message,
    code: error.code,
    status: error.status,
    retryAfter: error.retryAfter,
  };
}

function removeWaiter(waiter: AdmissionWaiter): void {
  const index = state.queue.indexOf(waiter);
  if (index >= 0) state.queue.splice(index, 1);
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}

function createAdmission(enqueuedAt: number): AIAdmission {
  state.active += 1;
  let released = false;
  const queueTimeMs = Date.now() - enqueuedAt;
  aiLogger.info({
    event: 'ai_admission_acquired',
    active: state.active,
    queued: state.queue.length,
    queueTimeMs,
  }, 'AI provider capacity acquired');
  return {
    queueTimeMs,
    release: () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      dispatchQueue();
    },
  };
}

function dispatchQueue(): void {
  const { concurrency } = getAIAdmissionConfig();
  while (state.active < concurrency && state.queue.length > 0) {
    const waiter = state.queue.shift()!;
    if (waiter.signal?.aborted) {
      waiter.reject(waiter.signal.reason);
      continue;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(createAdmission(waiter.enqueuedAt));
  }
}

export function acquireOllamaAdmission(signal?: AbortSignal): Promise<AIAdmission> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const config = getAIAdmissionConfig();
  if (state.active < config.concurrency) {
    return Promise.resolve(createAdmission(Date.now()));
  }
  if (state.queue.length >= config.queueLength) {
    aiLogger.warn({
      event: 'ai_admission_rejected',
      active: state.active,
      queued: state.queue.length,
      concurrency: config.concurrency,
      queueLength: config.queueLength,
    }, 'AI provider capacity rejected');
    return Promise.reject(new AIAdmissionRejectedError());
  }

  return new Promise<AIAdmission>((resolve, reject) => {
    const waiter: AdmissionWaiter = {
      enqueuedAt: Date.now(),
      signal,
      resolve,
      reject,
    };
    if (signal) {
      waiter.onAbort = () => {
        removeWaiter(waiter);
        reject(signal.reason);
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    state.queue.push(waiter);
    aiLogger.info({
      event: 'ai_admission_queued',
      active: state.active,
      queued: state.queue.length,
    }, 'AI provider request queued');
  });
}

export async function acquireOllamaAdmissionWithTimeout(
  signal?: AbortSignal,
): Promise<AIAdmission> {
  const timeoutSignal = AbortSignal.timeout(getAIAdmissionConfig().timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await acquireOllamaAdmission(combinedSignal);
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new AIAdmissionRejectedError();
    }
    throw error;
  }
}

export function resetAIAdmissionControllerForTests(): void {
  for (const waiter of state.queue.splice(0)) {
    removeWaiter(waiter);
    waiter.reject(new Error('AI admission controller reset'));
  }
  state.active = 0;
}
