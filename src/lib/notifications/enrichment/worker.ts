import 'server-only';

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  ClaimedNotificationEnrichmentJob,
  NotificationEnrichmentRepository,
} from '@/db/persistence/notification-enrichment';
import { syncLogger } from '@/lib/logger';
import { AIRoutingDeniedError } from '@/lib/ai/sensitivity-policy';
import {
  NotificationEnrichmentPermanentError,
  type AIEnrichmentResult,
} from './ai-enrichment-policy';
import { enrichWithAI } from './ai-enrichment-service';

export const DEFAULT_NOTIFICATION_ENRICHMENT_LEASE_MS = 60_000;
export const DEFAULT_NOTIFICATION_ENRICHMENT_TIMEOUT_MS = 45_000;
export const DEFAULT_NOTIFICATION_ENRICHMENT_MAX_ATTEMPTS = 5;
export const DEFAULT_NOTIFICATION_ENRICHMENT_RETRY_BASE_MS = 15_000;
export const MAX_NOTIFICATION_ENRICHMENT_RETRY_MS = 60 * 60_000;

export type NotificationEnrichmentExecutor = (
  input: ClaimedNotificationEnrichmentJob['payload'],
  options: { signal: AbortSignal },
) => Promise<AIEnrichmentResult | null>;

export interface NotificationEnrichmentWorkerOptions {
  owner?: string;
  leaseMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  pollMs?: number;
  repository?: NotificationEnrichmentRepository;
  execute?: NotificationEnrichmentExecutor;
  now?: () => Date;
  isEnabled?(): boolean;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function calculateNotificationEnrichmentRetryDelayMs(
  attemptCount: number,
  baseMs = DEFAULT_NOTIFICATION_ENRICHMENT_RETRY_BASE_MS,
): number {
  return Math.min(
    baseMs * (2 ** Math.max(0, attemptCount - 1)),
    MAX_NOTIFICATION_ENRICHMENT_RETRY_MS,
  );
}

function failure(error: unknown): { code: string; permanent: boolean; type: string } {
  const type = error instanceof Error ? error.name : typeof error;
  if (error instanceof NotificationEnrichmentPermanentError) {
    return { code: 'invalid_ai_response', permanent: true, type };
  }
  if (error instanceof AIRoutingDeniedError) {
    return { code: 'routing_policy_denied', permanent: true, type };
  }
  if (
    error instanceof DOMException
    && error.name === 'TimeoutError'
  ) {
    return { code: 'execution_timeout', permanent: false, type };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'execution_aborted', permanent: false, type };
  }
  return { code: 'enrichment_failed', permanent: false, type };
}

function metadata(result: AIEnrichmentResult | null, completedAt: string) {
  return result
    ? {
        aiSummary: result.summary,
        aiSuggestedAction: result.suggestedAction,
        aiSuggestedActionReason: result.suggestedActionReason,
        aiContextTags: result.contextTags,
        aiUrgencyBoost: result.urgencyBoost,
        aiEnrichedAt: completedAt,
      }
    : { aiEnrichedAt: completedAt, aiEnrichmentSkipped: true };
}

export class NotificationEnrichmentWorker {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly pollMs: number;
  private readonly execute: NotificationEnrichmentExecutor;
  private readonly now: () => Date;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private wakeWaiter: (() => void) | null = null;

  constructor(private readonly options: NotificationEnrichmentWorkerOptions = {}) {
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? positiveInteger(
      process.env.MC_NOTIFICATION_ENRICHMENT_LEASE_MS,
      DEFAULT_NOTIFICATION_ENRICHMENT_LEASE_MS,
    );
    this.timeoutMs = options.timeoutMs ?? positiveInteger(
      process.env.MC_NOTIFICATION_ENRICHMENT_TIMEOUT_MS,
      DEFAULT_NOTIFICATION_ENRICHMENT_TIMEOUT_MS,
    );
    this.maxAttempts = options.maxAttempts ?? positiveInteger(
      process.env.MC_NOTIFICATION_ENRICHMENT_MAX_ATTEMPTS,
      DEFAULT_NOTIFICATION_ENRICHMENT_MAX_ATTEMPTS,
    );
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_NOTIFICATION_ENRICHMENT_RETRY_BASE_MS;
    this.pollMs = options.pollMs ?? 500;
    this.execute = options.execute ?? enrichWithAI;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  private async repository(): Promise<NotificationEnrichmentRepository> {
    if (this.options.repository) return this.options.repository;
    const { getWorkerPersistenceRepositories } = await import('@/lib/persistence/worker-runtime');
    return (await getWorkerPersistenceRepositories()).notificationEnrichment;
  }

  private async run(): Promise<void> {
    let repository: NotificationEnrichmentRepository | null = null;
    let recoveredStaleLeases = false;
    while (!this.stopping) {
      try {
        if (this.options.isEnabled?.() === false) {
          await this.delay(this.pollMs);
          continue;
        }
        repository ??= await this.repository();
        if (this.options.isEnabled?.() === false) continue;
        if (!recoveredStaleLeases) {
          const recovered = await repository.recoverStaleLeases({ now: this.now() });
          recoveredStaleLeases = true;
          if (recovered > 0) {
            syncLogger.warn({ recovered }, 'Recovered stale notification enrichment leases');
          }
        }
        if (this.options.isEnabled?.() === false) continue;
        if (!await this.runOnce(repository)) {
          await this.delay(this.pollMs);
        }
      } catch (error) {
        syncLogger.error(
          { errorType: error instanceof Error ? error.name : typeof error },
          'Notification enrichment worker iteration failed',
        );
        if (!this.stopping) {
          await this.delay(Math.max(this.pollMs, 100));
        }
      }
    }
  }

  async runOnce(repository?: NotificationEnrichmentRepository): Promise<boolean> {
    if (this.options.isEnabled?.() === false) return false;
    const selected = repository ?? await this.repository();
    if (this.options.isEnabled?.() === false) return false;
    const claim = await selected.claimNext({
      now: this.now(),
      leaseMs: this.leaseMs,
      owner: this.owner,
    });
    if (!claim) return false;
    await this.process(selected, claim);
    return true;
  }

  private async process(
    repository: NotificationEnrichmentRepository,
    claim: ClaimedNotificationEnrichmentJob,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    const timeout = setTimeout(() => {
      controller.abort(new DOMException('Notification enrichment timed out', 'TimeoutError'));
    }, this.timeoutMs);
    timeout.unref?.();
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new DOMException('Notification enrichment aborted', 'AbortError'),
      );
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
    });
    const heartbeat = setInterval(() => {
      void repository.heartbeat(
        claim,
        new Date(this.now().getTime() + this.leaseMs).toISOString(),
      ).then((extended) => {
        if (!extended) {
          controller.abort(new DOMException('Notification enrichment lease lost', 'AbortError'));
        }
      }).catch(() => {
        controller.abort(new DOMException('Notification enrichment heartbeat failed', 'AbortError'));
      });
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();

    try {
      const result = await Promise.race([
        this.execute(claim.payload, { signal: controller.signal }),
        aborted,
      ]);
      const completedAt = this.now().toISOString();
      const outcome = await repository.complete(claim, {
        metadata: metadata(result, completedAt),
        completedAt,
      });
      if (outcome === 'fenced') {
        syncLogger.warn({ jobId: claim.id }, 'Notification enrichment completion was fenced');
      }
    } catch (error) {
      const outcome = failure(error);
      const completedAt = this.now().toISOString();
      const exhausted = outcome.permanent || claim.attemptCount >= this.maxAttempts;
      const persisted = exhausted
        ? await repository.deadLetter(claim, {
            lastError: outcome.permanent ? outcome.code : 'retry_limit_exhausted',
            completedAt,
          })
        : await repository.scheduleRetry(claim, {
            lastError: outcome.code,
            nextAttemptAt: new Date(
              this.now().getTime()
              + calculateNotificationEnrichmentRetryDelayMs(
                claim.attemptCount,
                this.retryBaseMs,
              ),
            ).toISOString(),
          });
      const context = {
        jobId: claim.id,
        notificationId: claim.notificationId,
        attemptCount: claim.attemptCount,
        failureCode: outcome.code,
        errorType: outcome.type,
        persisted,
      };
      if (exhausted) {
        syncLogger.error(context, 'Notification enrichment moved to dead letter');
      } else {
        syncLogger.warn(context, 'Notification enrichment scheduled for retry');
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      removeAbortListener();
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWaiter = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wakeWaiter = () => {
        clearTimeout(timer);
        this.wakeWaiter = null;
        resolve();
      };
    });
  }

  wake(): void {
    this.wakeWaiter?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake();
    this.activeController?.abort(new DOMException('Worker shutting down', 'AbortError'));
    await this.loop;
  }
}
