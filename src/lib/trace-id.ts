const TRACE_ID_PATTERN = /^(?=.*[0-9a-fA-F])[0-9a-fA-F-]{8,64}$/;

export function normalizeTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value)
    ? value
    : undefined;
}
