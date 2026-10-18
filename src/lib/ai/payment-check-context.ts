export interface AIPaymentCheckContext {
  state: string;
  checkedAt?: string;
  freshUntil?: string;
  source?: string;
  message?: string;
  searchContext?: {
    windowStart?: string;
    windowEnd?: string;
    sourceAsOf?: string;
    searchedAt?: string;
  };
  candidates: Array<{
    payee: string;
    amount: number;
    currency: string;
    transactionDate: string;
    status: 'posted' | 'pending';
    accountDisplayName: string;
    accountLastFour: string;
    confidence: number;
    score: number;
    matchReasons: string[];
  }>;
}

export function projectPaymentCheckContext(metadata: unknown): AIPaymentCheckContext | undefined {
  const parsed = parseMetadata(metadata);
  const paymentCheck = record(parsed?.paymentCheck);
  if (!paymentCheck || typeof paymentCheck.state !== 'string') return undefined;

  const candidates = Array.isArray(paymentCheck.candidates)
    ? paymentCheck.candidates
      .map((candidate) => projectCandidate(record(candidate)))
      .filter((candidate): candidate is NonNullable<ReturnType<typeof projectCandidate>> => !!candidate)
      .slice(0, 3)
    : [];
  const searchContext = record(paymentCheck.searchContext);

  return {
    state: paymentCheck.state,
    checkedAt: stringValue(paymentCheck.checkedAt),
    freshUntil: stringValue(paymentCheck.freshUntil),
    source: stringValue(paymentCheck.source),
    message: stringValue(paymentCheck.message),
    searchContext: searchContext ? {
      windowStart: stringValue(searchContext.windowStart),
      windowEnd: stringValue(searchContext.windowEnd),
      sourceAsOf: stringValue(searchContext.sourceAsOf),
      searchedAt: stringValue(searchContext.searchedAt),
    } : undefined,
    candidates,
  };
}

function projectCandidate(candidate: Record<string, unknown> | undefined) {
  if (
    !candidate
    || typeof candidate.payee !== 'string'
    || typeof candidate.amount !== 'number'
    || !Number.isFinite(candidate.amount)
    || typeof candidate.currency !== 'string'
    || typeof candidate.transactionDate !== 'string'
    || (candidate.status !== 'posted' && candidate.status !== 'pending')
    || typeof candidate.accountDisplayName !== 'string'
    || typeof candidate.accountLastFour !== 'string'
    || typeof candidate.confidence !== 'number'
    || !Number.isFinite(candidate.confidence)
    || typeof candidate.score !== 'number'
    || !Number.isFinite(candidate.score)
  ) {
    return null;
  }
  const status: 'posted' | 'pending' = candidate.status;
  return {
    payee: candidate.payee,
    amount: candidate.amount,
    currency: candidate.currency,
    transactionDate: candidate.transactionDate,
    status,
    accountDisplayName: candidate.accountDisplayName,
    accountLastFour: candidate.accountLastFour,
    confidence: candidate.confidence,
    score: candidate.score,
    matchReasons: Array.isArray(candidate.matchReasons)
      ? candidate.matchReasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 5)
      : [],
  };
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return record(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
