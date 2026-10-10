import 'server-only';

import { randomUUID } from 'node:crypto';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import {
  MonarchBridgeClient,
  type MonarchCategory,
  type MonarchTransaction,
} from '@/lib/connectors/monarch-money/client';
import { applyManualAttributionDecision } from '@/lib/connectors/monarch-money/attribution-service';
import { FinanceManagerConnector } from '@/lib/connectors/monarch-money';
import { TyrionFinanceReviewClient } from '@/lib/connectors/monarch-money/quick-review-client';
import {
  FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
  type FinanceReviewActionRequest,
  type FinanceReviewFilters,
  type FinanceReviewItem,
  type FinanceReviewSession,
  type FinanceReviewSessionRequest,
  type TyrionQuickReviewRankRequest,
} from '@/lib/finance/quick-review-contract';

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSION_ITEMS = 5_000;

interface SessionTarget {
  sourceRef: string;
  reviewRef: string;
  stateToken: string;
  localTransactionId: string | null;
  transaction: MonarchTransaction;
  item: FinanceReviewItem;
}

interface ServerSession {
  connectorId: string;
  sessionRef: string;
  resumeToken: string;
  sourceAsOf: string;
  mode: 'ranked' | 'period';
  filters: FinanceReviewFilters;
  targets: SessionTarget[];
  cursor: number;
  reviewed: number;
  skipped: number;
  expiresAt: number;
  completedActions: Map<string, FinanceReviewSession>;
  pendingActions: Map<string, Promise<FinanceReviewSession>>;
  actionInFlight: boolean;
}

const sessions = new Map<string, ServerSession>();

function sessionStore(): Map<string, ServerSession> {
  const globalStore = globalThis as typeof globalThis & {
    __financeQuickReviewSessions?: Map<string, ServerSession>;
  };
  globalStore.__financeQuickReviewSessions ??= sessions;
  return globalStore.__financeQuickReviewSessions;
}

function opaque(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function householdCurrency(settings: unknown): string {
  const value = settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>).householdCurrency
    : null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new Error('Finance connector household currency is not configured');
  }
  return value;
}

function dateRange(request: FinanceReviewSessionRequest): { startDate: string; endDate: string } {
  const endDate = request.filters.endDate ?? new Date().toISOString().slice(0, 10);
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 89);
  return {
    startDate: request.filters.startDate ?? start.toISOString().slice(0, 10),
    endDate,
  };
}

function matchesFilters(transaction: MonarchTransaction, filters: FinanceReviewFilters): boolean {
  const amount = Math.abs(transaction.amount);
  return (filters.minimumAmount === null || amount >= filters.minimumAmount)
    && (filters.maximumAmount === null || amount <= filters.maximumAmount)
    && (filters.accountNames.length === 0 || filters.accountNames.includes(transaction.account.displayName));
}

function attributionFor(local: {
  assignedKidId: string | null;
  manualDecisionAction: 'assign-kid' | 'parent-expense' | null;
  attributionConfidence: 'definite' | 'likely' | 'none' | null;
  attributionReviewState: 'not-required' | 'pending' | 'resolved';
} | undefined) {
  return {
    status: local?.manualDecisionAction === 'parent-expense'
      ? 'parent-expense' as const
      : local?.assignedKidId
        ? 'assigned' as const
        : 'unassigned' as const,
    confidence: local?.attributionConfidence === 'definite'
      ? 'definite' as const
      : local?.attributionConfidence === 'likely'
        ? 'likely' as const
        : 'unknown' as const,
    reviewStatus: local?.attributionReviewState === 'pending'
      ? 'needs-review' as const
      : 'none' as const,
  };
}

function signalsFor(
  transaction: MonarchTransaction,
  attribution: ReturnType<typeof attributionFor>,
): TyrionQuickReviewRankRequest['items'][number]['signals'] {
  const signals: TyrionQuickReviewRankRequest['items'][number]['signals'] = [];
  if (attribution.status === 'unassigned' || attribution.confidence === 'unknown') {
    signals.push('kid-attribution-ambiguous');
  }

  if (!transaction.category) signals.push('category-mismatch');
  if (!transaction.merchant.name.trim()) signals.push('unknown-merchant');
  if (transaction.reviewStatus === 'needs_review') signals.push('monarch-needs-review');
  return signals;
}

export function merchantNameForRank(merchantName: string): string {
  return merchantName.trim() || 'Unknown merchant';
}

export function assertQuickReviewCategoryCorrectionSupported(
  categoryId: string | null | undefined,
  currentCategoryId: string | null,
): void {
  if (categoryId === null && currentCategoryId !== null) {
    throw new QuickReviewSessionError(
      'category_removal_unavailable',
      'Removing a Monarch category is not supported by the current Bridge contract',
      422,
    );
  }
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    'kid-attribution-ambiguous': 'Kids attribution needs review',
    'payee-ambiguous': 'Payee is ambiguous',
    'category-mismatch': 'Category may not match',
    'unknown-merchant': 'Merchant is unfamiliar',
    'new-merchant': 'Merchant is new',
    'monarch-needs-review': 'Monarch marks this transaction as needs review',
  };
  return labels[reason] ?? reason;
}

function response(session: ServerSession): FinanceReviewSession {
  const current = session.targets[session.cursor]?.item ?? null;
  return {
    contractVersion: FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
    sessionRef: session.sessionRef,
    resumeToken: session.resumeToken,
    sourceAsOf: session.sourceAsOf,
    mode: session.mode,
    filters: session.filters,
    progress: {
      reviewed: session.reviewed,
      skipped: session.skipped,
      total: session.targets.length,
      remaining: Math.max(0, session.targets.length - session.cursor),
    },
    current,
    accounts: [...new Set(session.targets.map((target) => target.transaction.account.displayName))].sort(),
  };
}

function requireSession(request: Pick<FinanceReviewActionRequest, 'sessionRef' | 'resumeToken'>): ServerSession {
  const session = sessionStore().get(request.resumeToken);
  if (!session || session.sessionRef !== request.sessionRef || session.expiresAt < Date.now()) {
    if (session) sessionStore().delete(request.resumeToken);
    throw new QuickReviewSessionError('review_session_expired', 'Review session expired', 409);
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

export class QuickReviewSessionError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'QuickReviewSessionError';
  }
}

export async function runQuickReviewWriteSequence(operations: {
  updateCategory?: () => Promise<void>;
  updateMerchant?: () => Promise<void>;
  updateKidAttribution?: () => Promise<void>;
  markReviewed: () => Promise<void>;
}): Promise<void> {
  await operations.updateCategory?.();
  await operations.updateMerchant?.();
  await operations.updateKidAttribution?.();
  await operations.markReviewed();
}

export async function runExclusiveQuickReviewAction<T>(input: {
  idempotencyKey: string;
  completed: Map<string, T>;
  pending: Map<string, Promise<T>>;
  isActive: () => boolean;
  setActive: (active: boolean) => void;
  operation: () => Promise<T>;
}): Promise<T> {
  const replay = input.completed.get(input.idempotencyKey);
  if (replay) return replay;
  const pending = input.pending.get(input.idempotencyKey);
  if (pending) return pending;
  if (input.isActive()) {
    throw new QuickReviewSessionError(
      'review_action_in_progress',
      'Another review action is still in progress',
      409,
    );
  }
  input.setActive(true);
  const operation = Promise.resolve().then(input.operation);
  input.pending.set(input.idempotencyKey, operation);
  try {
    return await operation;
  } finally {
    input.pending.delete(input.idempotencyKey);
    input.setActive(false);
  }
}

export async function startQuickReviewSession(
  request: FinanceReviewSessionRequest,
  signal?: AbortSignal,
): Promise<FinanceReviewSession> {
  if (request.resumeToken) {
    const resumed = sessionStore().get(request.resumeToken);
    if (!resumed || resumed.expiresAt < Date.now()) {
      if (resumed) sessionStore().delete(request.resumeToken);
      throw new QuickReviewSessionError('review_session_expired', 'Review session expired', 409);
    }
    resumed.expiresAt = Date.now() + SESSION_TTL_MS;
    return response(resumed);
  }

  const config = await getPersistedFinanceConnectorConfig(request.connectorId);
  const bridge = new MonarchBridgeClient(config);
  const range = dateRange(request);
  const transactions: MonarchTransaction[] = [];
  let cursor: string | undefined;
  do {
    const page = await bridge.getTransactionsPage({
      ...range,
      limit: Math.min(500, MAX_SESSION_ITEMS - transactions.length),
      ...(cursor ? { cursor } : {}),
    }, signal);
    transactions.push(...page.transactions.filter((transaction) => matchesFilters(transaction, request.filters)));
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor && transactions.length < MAX_SESSION_ITEMS);

  const repositories = await getWorkerPersistenceRepositories();
  const [locals, kids, categoryResponse] = await Promise.all([
    repositories.finance.web.listTransactions({
      connectorId: config.id,
      startDate: range.startDate,
      endDate: range.endDate,
      kidId: null,
      category: null,
      triageStatus: null,
      limit: MAX_SESSION_ITEMS,
    }),
    repositories.finance.web.listKidsWithSpending(config.id, `${range.endDate.slice(0, 7)}-01`),
    bridge.getCategories(signal),
  ]);
  const localByUpstreamId = new Map(locals.map((transaction) => [transaction.upstreamTransactionId, transaction]));
  const kidById = new Map(kids.map((kid) => [kid.id, kid]));
  const sourceRefs = new Map(transactions.map((transaction) => [transaction.id, opaque('source')]));
  if (transactions.length === 0) {
    const session: ServerSession = {
      connectorId: config.id,
      sessionRef: opaque('session'),
      resumeToken: opaque('resume'),
      sourceAsOf: new Date().toISOString(),
      mode: request.mode,
      filters: request.filters,
      targets: [],
      cursor: 0,
      reviewed: 0,
      skipped: 0,
      expiresAt: Date.now() + SESSION_TTL_MS,
      completedActions: new Map(),
      pendingActions: new Map(),
      actionInFlight: false,
    };
    sessionStore().set(session.resumeToken, session);
    return response(session);
  }
  const rankInput = transactions.map((transaction) => {
    const attribution = attributionFor(localByUpstreamId.get(transaction.id));
    return {
      sourceRef: sourceRefs.get(transaction.id)!,
      occurredOn: transaction.date,
      merchantName: merchantNameForRank(transaction.merchant.name),
      isPending: transaction.isPending,
      monarchReviewStatus: transaction.reviewStatus,
      attribution,
      signals: signalsFor(transaction, attribution),
    };
  });
  const ranked = [];
  const tyrion = new TyrionFinanceReviewClient();
  for (let index = 0; index < rankInput.length; index += 100) {
    const result = await tyrion.rank({
      contractVersion: FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
      items: rankInput.slice(index, index + 100),
    }, signal);
    ranked.push(...result.rankedItems);
  }
  const scoreByRef = new Map(ranked.map((item) => [item.sourceRef, item]));
  const rankInputByRef = new Map(rankInput.map((item) => [item.sourceRef, item]));
  const ordered = [...transactions].sort((left, right) => {
    const leftRank = scoreByRef.get(sourceRefs.get(left.id)!)!;
    const rightRank = scoreByRef.get(sourceRefs.get(right.id)!)!;
    const leftInput = rankInputByRef.get(leftRank.sourceRef)!;
    const rightInput = rankInputByRef.get(rightRank.sourceRef)!;
    const presetDifference = request.filters.preset === 'highest-amount'
      ? Math.abs(right.amount) - Math.abs(left.amount)
      : request.filters.preset === 'newest' || request.mode === 'period'
        ? right.date.localeCompare(left.date)
        : request.filters.preset === 'kids-uncertainty'
          ? Number(rightInput.signals.includes('kid-attribution-ambiguous'))
            - Number(leftInput.signals.includes('kid-attribution-ambiguous'))
          : request.filters.preset === 'category-uncertainty'
            ? Number(rightInput.signals.includes('category-mismatch'))
              - Number(leftInput.signals.includes('category-mismatch'))
            : request.filters.preset === 'payee-uncertainty'
              ? Number(
                rightInput.signals.includes('payee-ambiguous')
                || rightInput.signals.includes('unknown-merchant'),
              ) - Number(
                leftInput.signals.includes('payee-ambiguous')
                || leftInput.signals.includes('unknown-merchant'),
              )
              : 0;
    return presetDifference
      || rightRank.score - leftRank.score
      || right.date.localeCompare(left.date)
      || leftRank.sourceRef.localeCompare(rightRank.sourceRef);
  });
  const categories = categoryResponse.categories.filter((category) => category.isActive);
  const currency = householdCurrency(config.settings);
  const targets: SessionTarget[] = ordered.map((transaction): SessionTarget => {
    const local = localByUpstreamId.get(transaction.id);
    const rankedItem = scoreByRef.get(sourceRefs.get(transaction.id)!)!;
    const kid = local?.assignedKidId ? kidById.get(local.assignedKidId) : null;
    const reviewRef = opaque('review');
    const stateToken = opaque('state');
    return {
      sourceRef: rankedItem.sourceRef,
      reviewRef,
      stateToken,
      localTransactionId: local?.id ?? null,
      transaction,
      item: {
        reviewRef,
        stateToken,
        date: transaction.date,
        amount: transaction.amount,
        currency,
        accountName: transaction.account.displayName,
        payee: merchantNameForRank(transaction.merchant.name),
        businessContext: transaction.businessContext ?? null,
        category: transaction.category
          ? { id: transaction.category.id, label: transaction.category.name }
          : null,
        kid: kid ? { id: kid.id, label: kid.name } : null,
        monarchReview: {
          status: transaction.reviewStatus === 'needs_review' ? 'needs-review' : 'reviewed',
          assignedTo: transaction.reviewAssignee ?? null,
        },
        whySelected: rankedItem.reasons.length
          ? rankedItem.reasons.map(reasonLabel)
          : ['Selected for this review period'],
        confidence: {
          overall: rankedItem.score / 100,
          kids: local?.attributionConfidence === 'definite'
            ? 1
            : local?.attributionConfidence === 'likely' ? 0.7 : null,
          category: transaction.category ? 0.8 : null,
          payee: transaction.merchant.name ? 0.8 : null,
        },
        corrections: {
          kids: kids.map((candidate) => ({ id: candidate.id, label: candidate.name })),
          categories: categories.map((category: MonarchCategory) => ({
            id: category.id,
            label: category.name,
          })),
          payeeSuggestions: [],
          maySuggestKidRule: true,
        },
        research: {
          recommended: rankedItem.reasons.some((reason) => (
            reason === 'unknown-merchant' || reason === 'new-merchant' || reason === 'category-mismatch'
          )),
          reason: rankedItem.reasons.includes('unknown-merchant') ? 'Merchant is unfamiliar' : null,
          normalizedVendorName: merchantNameForRank(transaction.merchant.name).replace(/\s+/g, ' ').trim(),
          coarseLocation: null,
        },
      },
    };
  });
  const session: ServerSession = {
    connectorId: config.id,
    sessionRef: opaque('session'),
    resumeToken: opaque('resume'),
    sourceAsOf: new Date().toISOString(),
    mode: request.mode,
    filters: request.filters,
    targets,
    cursor: 0,
    reviewed: 0,
    skipped: 0,
    expiresAt: Date.now() + SESSION_TTL_MS,
    completedActions: new Map(),
    pendingActions: new Map(),
    actionInFlight: false,
  };
  sessionStore().set(session.resumeToken, session);
  return response(session);
}

export async function applyQuickReviewAction(
  request: FinanceReviewActionRequest,
  actorType: 'parent-admin' | 'service',
  signal?: AbortSignal,
): Promise<FinanceReviewSession> {
  const session = requireSession(request);
  return runExclusiveQuickReviewAction({
    idempotencyKey: request.idempotencyKey,
    completed: session.completedActions,
    pending: session.pendingActions,
    isActive: () => session.actionInFlight,
    setActive: (active) => { session.actionInFlight = active; },
    operation: () => executeQuickReviewAction(session, request, actorType, signal),
  });
}

async function executeQuickReviewAction(
  session: ServerSession,
  request: FinanceReviewActionRequest,
  actorType: 'parent-admin' | 'service',
  signal?: AbortSignal,
): Promise<FinanceReviewSession> {
  const target = session.targets[session.cursor];
  if (
    !target
    || target.reviewRef !== request.reviewRef
    || target.stateToken !== request.stateToken
  ) {
    throw new QuickReviewSessionError('review_state_conflict', 'Review item changed', 409);
  }
  if (request.action === 'skip') {
    session.skipped += 1;
    session.cursor += 1;
    const result = response(session);
    session.completedActions.set(request.idempotencyKey, result);
    return result;
  }
  const config = await getPersistedFinanceConnectorConfig(session.connectorId);
  const bridge = new MonarchBridgeClient(config);
  let updateCategory: (() => Promise<void>) | undefined;
  let updateMerchant: (() => Promise<void>) | undefined;
  let updateKidAttribution: (() => Promise<void>) | undefined;
  if (request.action === 'correct' && request.correction) {
    assertQuickReviewCategoryCorrectionSupported(
      request.correction.categoryId,
      target.transaction.category?.id ?? null,
    );
    const needsLocalTarget = request.correction.kidId !== undefined
      || (
        request.correction.categoryId !== undefined
        && request.correction.categoryId !== null
        && request.correction.categoryId !== target.transaction.category?.id
      );
    if (needsLocalTarget && !target.localTransactionId) {
      throw new QuickReviewSessionError(
        'correction_target_unavailable',
        'Corrections are unavailable for this transaction until it is synchronized',
        409,
      );
    }
    if (
      request.correction.categoryId
      && request.correction.categoryId !== target.transaction.category?.id
    ) {
      const categoryId = request.correction.categoryId;
      updateCategory = async () => {
        const connector = new FinanceManagerConnector();
        await connector.initialize(config);
        await connector.updateCategory(
          target.localTransactionId!,
          categoryId,
          `${request.idempotencyKey}:category`,
          signal,
        );
      };
    }
    if (
      request.correction.payee
      && request.correction.payee !== target.transaction.merchant.name
    ) {
      const merchantName = request.correction.payee;
      updateMerchant = () => bridge.updateMerchant(target.transaction.id, merchantName, signal);
    }
    if (request.correction.kidId !== undefined) {
      const kidId = request.correction.kidId;
      updateKidAttribution = async () => {
        await applyManualAttributionDecision({
          connectorId: session.connectorId,
          transactionId: target.localTransactionId!,
          action: kidId ? 'assign-kid' : 'parent-expense',
          kidId: kidId ?? null,
          idempotencyKey: `${request.idempotencyKey}:kid`,
          actorType,
        });
      };
    }
  }
  await runQuickReviewWriteSequence({
    updateCategory,
    updateMerchant,
    updateKidAttribution,
    markReviewed: () => bridge.markReviewed(target.transaction.id, signal),
  });
  session.reviewed += 1;
  session.cursor += 1;
  const result = response(session);
  session.completedActions.set(request.idempotencyKey, result);
  return result;
}

export function getQuickReviewResearchContext(input: {
  sessionRef: string;
  resumeToken: string;
  reviewRef: string;
  stateToken: string;
}): {
  vendorName: string;
  coarseLocation: FinanceReviewItem['research']['coarseLocation'];
  amount: number;
  occurredOn: string;
} {
  const session = requireSession(input);
  const target = session.targets[session.cursor];
  if (
    !target
    || target.reviewRef !== input.reviewRef
    || target.stateToken !== input.stateToken
  ) {
    throw new QuickReviewSessionError('review_state_conflict', 'Review item changed', 409);
  }
  return {
    vendorName: target.item.research.normalizedVendorName,
    coarseLocation: target.item.research.coarseLocation,
    amount: target.item.amount,
    occurredOn: target.item.date,
  };
}
