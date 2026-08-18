import type { CopilotComparisonTraceRunner } from './copilot-route-comparison-tracing';
import {
  CopilotComparisonError,
  type CopilotComparisonRoute,
} from './copilot-route-comparison-contracts';

export interface RunCopilotComparisonInput {
  model: string;
  sensitivity: 'local-only' | 'restricted' | 'standard';
  repetitions: number;
  timeoutMs: number;
  cancellationAbortAfterMs: number;
  trace: CopilotComparisonTraceRunner;
  now?: () => Date;
  randomId?: () => string;
}

export function validateCopilotComparisonConfig(
  input: RunCopilotComparisonInput,
  routes: readonly [CopilotComparisonRoute, CopilotComparisonRoute],
): void {
  if (input.sensitivity !== 'standard') {
    throw new CopilotComparisonError('sensitivity_denied');
  }
  if (
    !/^[A-Za-z0-9._:/-]{1,160}$/.test(input.model) ||
    !Number.isInteger(input.repetitions) ||
    input.repetitions < 1 ||
    input.repetitions > 20 ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1_000 ||
    input.timeoutMs > 120_000 ||
    !Number.isInteger(input.cancellationAbortAfterMs) ||
    input.cancellationAbortAfterMs < 1 ||
    input.cancellationAbortAfterMs >= input.timeoutMs
  ) {
    throw new CopilotComparisonError('configuration_invalid');
  }
  if (
    new Set(routes.map((route) => route.id)).size !== 2 ||
    !routes.some((route) => route.id === 'bifrost') ||
    !routes.some((route) => route.id === 'direct-sdk')
  ) {
    throw new CopilotComparisonError('route_configuration_invalid');
  }
}
