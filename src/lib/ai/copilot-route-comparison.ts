import {
  COPILOT_ROUTE_COMPARISON_FIXTURES,
  COPILOT_ROUTE_COMPARISON_FIXTURE_VERSION,
  COPILOT_ROUTE_COMPARISON_SCHEMA_VERSION,
  CopilotComparisonError,
  type CopilotCancellationObservation,
  type CopilotComparisonFinalizationEvidence,
  type CopilotComparisonRoute,
  type CopilotComparisonRouteId,
  type CopilotComparisonRouteMetadata,
} from './copilot-route-comparison-contracts';
import {
  copilotComparisonTraceId,
  safeCopilotComparisonErrorCode,
  sanitizeCopilotComparisonAttemptEvidence,
  summarizeCopilotComparisonAttempts,
  validateCopilotComparisonEvidence,
  type CopilotComparisonAttempt,
  type CopilotComparisonRouteEvidence,
} from './copilot-route-comparison-evidence';
import {
  validateCopilotComparisonConfig,
  type RunCopilotComparisonInput,
} from './copilot-route-comparison-config';

export * from './copilot-route-comparison-config';
export * from './copilot-route-comparison-contracts';
export * from './copilot-route-comparison-evidence';

export async function runCopilotRouteComparison(
  input: RunCopilotComparisonInput,
  routes: readonly [CopilotComparisonRoute, CopilotComparisonRoute],
) {
  validateCopilotComparisonConfig(input, routes);

  const now = input.now ?? (() => new Date());
  const randomId = input.randomId ?? (() => crypto.randomUUID());
  const startedAt = now().toISOString();

  const initialized = await Promise.allSettled(
    routes.map((route) => route.initialize()),
  );
  if (initialized.some((result) => result.status === 'rejected')) {
    await Promise.allSettled(routes.map((route) => route.close()));
    throw new CopilotComparisonError('route_unavailable');
  }
  const routeMetadata = Object.fromEntries(
    initialized.map((result, index) => [
      routes[index].id,
      (result as PromiseFulfilledResult<CopilotComparisonRouteMetadata>).value,
    ]),
  ) as Record<CopilotComparisonRouteId, CopilotComparisonRouteMetadata>;

  const attempts: CopilotComparisonAttempt[] = [];
  for (let attempt = 1; attempt <= input.repetitions; attempt += 1) {
    const orderedRoutes =
      attempt % 2 === 1 ? routes : ([routes[1], routes[0]] as const);
    for (const fixture of COPILOT_ROUTE_COMPARISON_FIXTURES) {
      for (const route of orderedRoutes) {
        const correlationId = randomId();
        let rootTraceparent = '';
        try {
          const observation = await input.trace.runRoot(
            {
              correlationId,
              route: route.id,
              fixtureId: fixture.id,
              operation: 'request',
              model: input.model,
            },
            (context) => {
              rootTraceparent = context.traceparent;
              return route.execute(
                {
                  fixture,
                  model: input.model,
                  sensitivity: 'standard',
                  correlationId,
                  traceparent: context.traceparent,
                  timeoutMs: input.timeoutMs,
                },
                AbortSignal.timeout(input.timeoutMs),
              );
            },
          );
          const evaluation = fixture.evaluate(observation.content);
          attempts.push({
            route: route.id,
            fixtureId: fixture.id,
            attempt,
            correlationId,
            traceId: copilotComparisonTraceId(rootTraceparent),
            success: true,
            ...evaluation,
            modelMatched: observation.model === input.model,
            providerMatched: observation.provider === 'github-copilot',
            fallbackOccurred: observation.fallbackOccurred,
            correlationMatched: observation.correlationMatched,
            totalLatencyMs: observation.totalLatencyMs,
            ...(observation.timeToFirstTokenMs === undefined
              ? {}
              : { timeToFirstTokenMs: observation.timeToFirstTokenMs }),
            ...(observation.usage ? { usage: observation.usage } : {}),
            quota: observation.quota,
            cleanup: observation.cleanup,
            responseBytes: Buffer.byteLength(observation.content),
          });
        } catch (error) {
          const evidence = sanitizeCopilotComparisonAttemptEvidence(error);
          attempts.push({
            route: route.id,
            fixtureId: fixture.id,
            attempt,
            correlationId,
            traceId: rootTraceparent
              ? copilotComparisonTraceId(rootTraceparent)
              : 'unavailable',
            success: false,
            schemaValid: false,
            qualityPass: false,
            modelMatched: evidence?.modelMatched ?? false,
            providerMatched: evidence?.providerMatched ?? false,
            ...(evidence?.fallbackOccurred === undefined
              ? {}
              : { fallbackOccurred: evidence.fallbackOccurred }),
            ...(evidence?.correlationMatched === undefined
              ? {}
              : { correlationMatched: evidence.correlationMatched }),
            errorCode: safeCopilotComparisonErrorCode(error),
          });
        }
      }
    }
  }

  const cancellation = Object.fromEntries(
    await Promise.all(
      routes.map(async (route) => {
        const correlationId = randomId();
        try {
          let rootTraceparent = '';
          const observation = await input.trace.runRoot(
            {
              correlationId,
              route: route.id,
              fixtureId: COPILOT_ROUTE_COMPARISON_FIXTURES[0].id,
              operation: 'cancellation',
              model: input.model,
            },
            (context) => {
              rootTraceparent = context.traceparent;
              return route.cancel(
                {
                  fixture: COPILOT_ROUTE_COMPARISON_FIXTURES[0],
                  model: input.model,
                  sensitivity: 'standard',
                  correlationId,
                  traceparent: context.traceparent,
                  timeoutMs: input.timeoutMs,
                },
                input.cancellationAbortAfterMs,
              );
            },
          );
          return [
            route.id,
            {
              correlationId,
              traceId: copilotComparisonTraceId(rootTraceparent),
              ...observation,
            },
          ] as const;
        } catch (error) {
          return [
            route.id,
            {
              correlationId,
              traceId: 'unavailable',
              outcome: 'failed' as const,
              cancellationObserved: false,
              cleanup: 'failed' as const,
              totalLatencyMs: 0,
              errorCode: safeCopilotComparisonErrorCode(error),
            },
          ] as const;
        }
      }),
    ),
  ) as Record<
    CopilotComparisonRouteId,
    CopilotCancellationObservation & {
      correlationId: string;
      traceId: string;
    }
  >;

  const finalization = Object.fromEntries(
    await Promise.all(
      routes.map(async (route) => {
        try {
          return [route.id, await route.finalizeEvidence()] as const;
        } catch {
          return [
            route.id,
            {
              cleanupSucceeded: false,
              ...(route.id === 'direct-sdk'
                ? { traceExportSucceeded: false }
                : {}),
            },
          ] as const;
        }
      }),
    ),
  ) as Record<
    CopilotComparisonRouteId,
    CopilotComparisonFinalizationEvidence
  >;

  const byRoute = Object.fromEntries(
    routes.map((route) => {
      const routeAttempts = attempts.filter(
        (attempt) => attempt.route === route.id,
      );
      return [
        route.id,
        {
          metadata: routeMetadata[route.id],
          attempts: routeAttempts,
          summary: summarizeCopilotComparisonAttempts(routeAttempts),
          cancellation: cancellation[route.id],
          finalization: finalization[route.id],
        },
      ];
    }),
  ) as Record<CopilotComparisonRouteId, CopilotComparisonRouteEvidence>;

  const traceFlushSucceeded = await input.trace.forceFlush();
  const reasons = validateCopilotComparisonEvidence(
    byRoute,
    input.repetitions * COPILOT_ROUTE_COMPARISON_FIXTURES.length,
    traceFlushSucceeded,
  );

  return {
    schemaVersion: COPILOT_ROUTE_COMPARISON_SCHEMA_VERSION,
    fixtureVersion: COPILOT_ROUTE_COMPARISON_FIXTURE_VERSION,
    startedAt,
    completedAt: now().toISOString(),
    controls: {
      sensitivity: 'standard' as const,
      allowedBifrostRoutes: ['bifrost-copilot'] as const,
      model: input.model,
      repetitions: input.repetitions,
      timeoutMs: input.timeoutMs,
      streaming: 'disabled-for-equivalence' as const,
      tools: 'disabled-for-equivalence' as const,
      prompts: 'identical-after-adapter-serialization' as const,
      temperature: 'unavailable-on-both-paths' as const,
      seed: 'unavailable-on-both-paths' as const,
      runtimeEnvironment:
        'not-equivalent-bifrost-deployment-versus-direct-worker' as const,
    },
    trace: {
      root: 'real-opentelemetry-span' as const,
      exportFlushSucceeded: traceFlushSucceeded,
    },
    convergence: {
      converged: reasons.length === 0,
      reasons,
    },
    routes: byRoute,
  };
}
