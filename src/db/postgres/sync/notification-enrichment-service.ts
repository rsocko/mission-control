import type {
  AIEnrichmentService,
} from '@/lib/notifications/enrichment/ai-enrichment-service';
import type {
  NotificationEnrichmentExecutor,
} from '@/lib/notifications/enrichment/worker';
import { shouldEnrichWithAI } from '@/lib/notifications/enrichment/ai-enrichment-policy';

export function createPostgresAIEnrichmentService(): AIEnrichmentService {
  let executorPromise: Promise<NotificationEnrichmentExecutor> | null = null;

  return {
    async enrich(input, options) {
      if (!shouldEnrichWithAI(input)) return null;
      const { createPackagedNotificationEnrichmentExecutor } = await import(
        '@/lib/notifications/enrichment/packaged-executor'
      );
      executorPromise ??= createPackagedNotificationEnrichmentExecutor()
        .catch((error) => {
          executorPromise = null;
          throw error;
        });
      const executor = await executorPromise;
      return executor(input, {
        signal: options?.signal ?? new AbortController().signal,
      });
    },
  };
}
