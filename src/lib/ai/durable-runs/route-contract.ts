export const COPILOT_EXECUTION_ROUTE = 'direct-copilot-sdk' as const;
export const COPILOT_PROVIDER = 'github-copilot' as const;

export const DURABLE_AI_ENQUEUEABLE_ROUTES = [
  COPILOT_EXECUTION_ROUTE,
] as const;

export type DurableAiEnqueueableRoute =
  (typeof DURABLE_AI_ENQUEUEABLE_ROUTES)[number];
