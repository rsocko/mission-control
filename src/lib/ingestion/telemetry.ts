import { metrics } from '@opentelemetry/api';

export type IngestionSource =
  | 'direct-document'
  | 'embed-html'
  | 'local-file'
  | 'remote-document'
  | 'request'
  | 'thumbnail'
  | 'unknown';

export type IngestionRejectionReason =
  | 'aborted'
  | 'error'
  | 'limit'
  | 'timeout'
  | 'validation';

const meter = metrics.getMeter('mission-control-ingestion');
const operationCounter = meter.createCounter('mc.ingestion.operations', {
  description: 'Count of bounded ingestion operations by source and outcome',
});
const byteCounter = meter.createCounter('mc.ingestion.bytes', {
  description: 'Observed bytes in bounded ingestion operations',
  unit: 'By',
});
const durationHistogram = meter.createHistogram('mc.ingestion.duration', {
  description: 'Duration of bounded ingestion operations',
  unit: 'ms',
});

export function ingestionRejectionReason(error: unknown): IngestionRejectionReason {
  if (error instanceof Error) {
    if (error.name === 'IngestionLimitError') return 'limit';
    if (error.name === 'IngestionTimeoutError') return 'timeout';
    if (error.name === 'IngestionValidationError') return 'validation';
    if (error.name === 'AbortError') return 'aborted';
  }
  return 'error';
}

export function recordIngestionOutcome(input: {
  source: IngestionSource;
  outcome: 'accepted' | 'rejected';
  bytes: number;
  durationMs: number;
  reason?: IngestionRejectionReason;
}): void {
  const attributes = {
    'mc.ingestion.source': input.source,
    'mc.ingestion.outcome': input.outcome,
    'mc.ingestion.reason': input.reason ?? 'none',
  };
  operationCounter.add(1, attributes);
  byteCounter.add(Math.max(0, input.bytes), attributes);
  durationHistogram.record(Math.max(0, input.durationMs), attributes);
}
