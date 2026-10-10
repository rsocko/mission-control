'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleHelp,
  CloudOff,
  ExternalLink,
  Filter,
  Loader2,
  Search,
  ShieldCheck,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
  financeReviewSessionSchema,
  financeMerchantRuleCreateResponseSchema,
  financeQuickReviewRuleSuggestionResponseSchema,
  financeVendorResearchResponseSchema,
  TYRION_MERCHANT_RULE_CONTRACT_VERSION,
  type FinanceMerchantRuleCreateResponse,
  type FinanceQuickReviewRuleSuggestionResponse,
  type FinanceReviewActionRequest,
  type FinanceReviewFilters,
  type FinanceReviewItem,
  type FinanceReviewSession,
  type FinanceVendorResearchResponse,
} from '@/lib/finance/quick-review-contract';

const RESUME_KEY = 'mc.financeQuickReview.resume.v1';
const DEFAULT_FILTERS: FinanceReviewFilters = {
  preset: 'impact-confidence',
  startDate: null,
  endDate: null,
  minimumAmount: null,
  maximumAmount: null,
  accountNames: [],
};

const PRESETS: Array<{ value: FinanceReviewFilters['preset']; label: string }> = [
  { value: 'impact-confidence', label: 'High impact + low confidence' },
  { value: 'highest-amount', label: 'Highest amount' },
  { value: 'newest', label: 'Newest' },
  { value: 'kids-uncertainty', label: 'Kids uncertainty' },
  { value: 'category-uncertainty', label: 'Category uncertainty' },
  { value: 'payee-uncertainty', label: 'Payee uncertainty' },
  { value: 'custom', label: 'Custom filters' },
];

type ViewState = 'loading' | 'ready' | 'error';
type ActionName = 'confirm' | 'correct' | 'skip';
type MerchantRuleOutcome = 'kid' | 'parent-shared' | 'review';
type MerchantRuleScope = 'accounts' | 'global';

interface CorrectionDraft {
  kidId: string;
  categoryId: string;
  payee: string;
}

function clearResume() {
  sessionStorage.removeItem(RESUME_KEY);
}

interface ApiErrorBody {
  error?: string;
  code?: string;
  retryable?: boolean;
}

function freshDraft(item: FinanceReviewItem | null): CorrectionDraft {
  return {
    kidId: item?.kid?.id ?? '',
    categoryId: item?.category?.id ?? '',
    payee: item?.payee ?? '',
  };
}

function currency(item: FinanceReviewItem) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: item.currency,
    maximumFractionDigits: 2,
  }).format(Math.abs(item.amount));
}

function confidenceLabel(value: number | null) {
  if (value === null) return 'Unavailable';
  if (value >= 0.85) return `High · ${Math.round(value * 100)}%`;
  if (value >= 0.6) return `Medium · ${Math.round(value * 100)}%`;
  return `Low · ${Math.round(value * 100)}%`;
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLSelectElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function loadResumeToken(): string | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null') as {
      resumeToken?: unknown;
    } | null;
    return typeof parsed?.resumeToken === 'string' ? parsed.resumeToken : null;
  } catch {
    return null;
  }
}

function saveResume(session: FinanceReviewSession) {
  sessionStorage.setItem(RESUME_KEY, JSON.stringify({
    sessionRef: session.sessionRef,
    resumeToken: session.resumeToken,
  }));
}

function subscribeToConnectivity(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function FinanceQuickReview() {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [session, setSession] = useState<FinanceReviewSession | null>(null);
  const [mode, setMode] = useState<'ranked' | 'period'>('ranked');
  const [filters, setFilters] = useState<FinanceReviewFilters>(DEFAULT_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState<CorrectionDraft>(freshDraft(null));
  const [actionPending, setActionPending] = useState<ActionName | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const online = useSyncExternalStore(
    subscribeToConnectivity,
    () => navigator.onLine,
    () => true,
  );
  const [includeSensitiveContext, setIncludeSensitiveContext] = useState(false);
  const [researchDisclosureOpen, setResearchDisclosureOpen] = useState(false);
  const [researchPending, setResearchPending] = useState(false);
  const [research, setResearch] = useState<FinanceVendorResearchResponse | null>(null);
  const [rulePending, setRulePending] = useState(false);
  const [ruleSuggestion, setRuleSuggestion] = useState<
    FinanceQuickReviewRuleSuggestionResponse['suggestion']
  >(null);
  const [ruleOutcome, setRuleOutcome] = useState<MerchantRuleOutcome>('kid');
  const [ruleScope, setRuleScope] = useState<MerchantRuleScope>('accounts');
  const [ruleConfidence, setRuleConfidence] = useState<'definite' | 'likely'>('likely');
  const [businessEntityPattern, setBusinessEntityPattern] = useState('');
  const [globalScopeConfirmed, setGlobalScopeConfirmed] = useState(false);
  const [ruleCreatePending, setRuleCreatePending] = useState(false);
  const [createdRule, setCreatedRule] = useState<FinanceMerchantRuleCreateResponse | null>(null);
  const [ruleIdempotencyKey, setRuleIdempotencyKey] = useState<string | null>(null);
  const actionRegionRef = useRef<HTMLDivElement>(null);

  const item = session?.current ?? null;
  const completion = session && session.progress.total > 0
    ? Math.round(((session.progress.reviewed + session.progress.skipped) / session.progress.total) * 100)
    : 0;

  const startSession = useCallback(async (
    nextMode: 'ranked' | 'period',
    nextFilters: FinanceReviewFilters,
    resume: boolean,
  ) => {
    setViewState('loading');
    setError(null);
    setStatus(resume ? 'Resuming your finance review session...' : 'Starting a new finance review session...');
    try {
      const response = await fetch('/api/finance/quick-review/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractVersion: FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
          mode: nextMode,
          filters: nextFilters,
          resumeToken: resume ? loadResumeToken() : null,
        }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const apiError = body as ApiErrorBody | null;
        if (apiError?.code === 'review_session_expired') clearResume();
        setError({
          error: apiError?.error ?? 'Finance quick review could not be loaded.',
          code: apiError?.code,
          retryable: apiError?.retryable,
        });
        setViewState('error');
        return;
      }
      const parsed = financeReviewSessionSchema.safeParse(body);
      if (!parsed.success) throw new Error('Invalid finance review response');
      setSession(parsed.data);
      setMode(parsed.data.mode);
      setFilters(parsed.data.filters);
      setDraft(freshDraft(parsed.data.current));
      setCorrecting(false);
      setResearch(null);
      setRuleSuggestion(null);
      setCreatedRule(null);
      setRuleIdempotencyKey(null);
      saveResume(parsed.data);
      setStatus(resume ? 'Review session resumed.' : 'Review session ready.');
      setViewState('ready');
    } catch {
      setError({
        error: 'Mission Control could not reach the finance review service.',
        code: 'review_service_unavailable',
        retryable: true,
      });
      setViewState('error');
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void startSession('ranked', DEFAULT_FILTERS, true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [startSession]);

  const applyAction = useCallback(async (action: ActionName) => {
    if (!session || !item || actionPending || !online) return;
    setActionPending(action);
    setStatus(`${action === 'skip' ? 'Skipping' : action === 'confirm' ? 'Confirming' : 'Saving correction'}...`);
    const correction = action === 'correct'
      ? {
          kidId: draft.kidId || null,
          categoryId: draft.categoryId || null,
          payee: draft.payee.trim(),
        }
      : null;
    const request: FinanceReviewActionRequest = {
      contractVersion: FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
      sessionRef: session.sessionRef,
      resumeToken: session.resumeToken,
      reviewRef: item.reviewRef,
      stateToken: item.stateToken,
      idempotencyKey: crypto.randomUUID(),
      action,
      monarchReviewOutcome: action === 'skip' ? 'unchanged' : 'reviewed',
      correction,
    };
    try {
      const response = await fetch('/api/finance/quick-review/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const apiError = body as ApiErrorBody | null;
        setStatus(
          response.status === 409
            ? 'This transaction changed in Monarch or the session expired. Refresh before continuing.'
            : apiError?.error ?? 'The review action could not be completed.',
        );
        return;
      }
      const parsed = financeReviewSessionSchema.safeParse(body);
      if (!parsed.success) throw new Error('Invalid finance review response');
      setSession(parsed.data);
      setDraft(freshDraft(parsed.data.current));
      setCorrecting(false);
      setResearch(null);
      setRuleSuggestion(null);
      setCreatedRule(null);
      setRuleIdempotencyKey(null);
      saveResume(parsed.data);
      setStatus(
        action === 'skip'
          ? 'Transaction skipped for this session.'
          : action === 'correct'
            ? 'Correction written through to Monarch and marked reviewed.'
            : 'Transaction confirmed.',
      );
      requestAnimationFrame(() => actionRegionRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    } catch {
      setStatus('The review action could not be completed. Your place is saved; try again.');
    } finally {
      setActionPending(null);
    }
  }, [actionPending, draft, item, online, session]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void applyAction('confirm');
      } else if (event.key.toLowerCase() === 'x') {
        event.preventDefault();
        setCorrecting(true);
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void applyAction('skip');
      } else if (event.key === 'Escape') {
        setCorrecting(false);
        setResearchDisclosureOpen(false);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [applyAction]);

  const runResearch = async (approved: boolean) => {
    if (!session || !item || researchPending || !online) return;
    setResearchDisclosureOpen(false);
    setResearchPending(true);
    setStatus('Researching public vendor information...');
    try {
      const response = await fetch('/api/finance/quick-review/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractVersion: FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
          sessionRef: session.sessionRef,
          resumeToken: session.resumeToken,
          reviewRef: item.reviewRef,
          stateToken: item.stateToken,
          request: null,
          publicContext: {
            normalizedVendorName: item.research.normalizedVendorName,
            coarseLocation: item.research.coarseLocation,
            amount: approved ? item.amount : null,
            date: approved ? item.date : null,
            sensitiveContextApproved: approved,
          },
        }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const apiError = body as ApiErrorBody | null;
        setStatus(apiError?.error ?? 'Vendor research could not be completed.');
        return;
      }
      const parsed = financeVendorResearchResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error('Invalid vendor research response');
      setResearch(parsed.data);
      setStatus('Vendor research is ready. No transaction fields were changed.');
    } catch {
      setStatus('Vendor research could not be completed. Try again.');
    } finally {
      setResearchPending(false);
    }
  };

  const previewRuleSuggestion = async () => {
    if (!session || !item || !draft.kidId || rulePending || !online) return;
    setRulePending(true);
    setRuleSuggestion(null);
    try {
      const response = await fetch('/api/finance/quick-review/rule-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractVersion: FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
          sessionRef: session?.sessionRef,
          resumeToken: session?.resumeToken,
          reviewRef: item.reviewRef,
          stateToken: item.stateToken,
          merchantName: draft.payee.trim(),
          kidId: draft.kidId,
          suggestReusableRule: true,
        }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const apiError = body as ApiErrorBody | null;
        setStatus(apiError?.error ?? 'A reusable rule suggestion could not be prepared.');
        return;
      }
      const parsed = financeQuickReviewRuleSuggestionResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error('Invalid rule suggestion response');
      setRuleSuggestion(parsed.data.suggestion);
      setCreatedRule(null);
      setRuleIdempotencyKey(crypto.randomUUID());
      setRuleOutcome('kid');
      setRuleScope('accounts');
      setRuleConfidence(parsed.data.suggestion?.confidence ?? 'likely');
      setBusinessEntityPattern(parsed.data.suggestion?.businessEntityPattern ?? '');
      setGlobalScopeConfirmed(false);
      setStatus(parsed.data.suggestion
        ? 'Rule suggestion ready. It has not been applied.'
        : 'Tyrion did not suggest a reusable rule.');
    } catch {
      setStatus('A reusable rule suggestion could not be prepared.');
    } finally {
      setRulePending(false);
    }
  };

  const createMerchantRule = async () => {
    if (
      !session
      || !item
      || !ruleSuggestion
      || !ruleIdempotencyKey
      || ruleCreatePending
      || !online
    ) return;
    setRuleCreatePending(true);
    setCreatedRule(null);
    setStatus('Creating the confirmed merchant rule...');
    try {
      const response = await fetch('/api/finance/quick-review/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractVersion: TYRION_MERCHANT_RULE_CONTRACT_VERSION,
          sessionRef: session.sessionRef,
          resumeToken: session.resumeToken,
          reviewRef: item.reviewRef,
          stateToken: item.stateToken,
          idempotencyKey: ruleIdempotencyKey,
          confirmation: {
            confirmed: true,
            confirmedAt: new Date().toISOString(),
            globalScopeConfirmed: ruleScope === 'global' && globalScopeConfirmed,
          },
          rule: {
            outcome: ruleOutcome,
            kidId: ruleOutcome === 'kid' ? ruleSuggestion.kidId : null,
            pattern: ruleSuggestion.merchantPattern,
            businessEntityPattern: businessEntityPattern.trim() || null,
            scope: ruleScope,
            confidence: ruleConfidence,
          },
        }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const apiError = body as ApiErrorBody | null;
        if (response.status === 409) {
          setRuleSuggestion(null);
          setRuleIdempotencyKey(null);
          setStatus('The attribution policy changed. Preview the rule again before confirming.');
        } else {
          setStatus(apiError?.error ?? 'The merchant rule could not be created.');
        }
        return;
      }
      const parsed = financeMerchantRuleCreateResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error('Invalid merchant rule creation response');
      setCreatedRule(parsed.data);
      setRuleSuggestion(null);
      setStatus(parsed.data.outcome === 'replayed'
        ? 'This merchant rule was already created.'
        : 'Merchant rule created. The transaction correction remains unchanged.');
    } catch {
      setStatus('The merchant rule could not be created. Review the settings and try again.');
    } finally {
      setRuleCreatePending(false);
    }
  };

  const canCorrect = useMemo(() => {
    if (!item) return false;
    return draft.payee.trim().length > 0 && (
      draft.kidId !== (item.kid?.id ?? '')
      || draft.categoryId !== (item.category?.id ?? '')
      || draft.payee.trim() !== item.payee
    );
  }, [draft, item]);

  if (viewState === 'loading') {
    return (
      <div role="status" className="flex h-full min-h-[420px] items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 size-5 motion-safe:animate-spin" />
        {status || 'Loading finance quick review...'}
      </div>
    );
  }

  if (viewState === 'error') {
    const contractMissing = error?.code === 'review_contract_unavailable';
    return (
      <main className="flex h-full min-h-[420px] items-center justify-center p-5">
        <section role="alert" className="w-full max-w-lg rounded-xl border border-amber-400/30 bg-[var(--surface-1)] p-5 text-center">
          <AlertTriangle className="mx-auto size-7 text-amber-300" />
          <h1 className="mt-3 text-base font-semibold text-[var(--text-primary)]">
            {contractMissing ? 'Tyrion quick review is not available yet' : 'Finance quick review is unavailable'}
          </h1>
          <p className="mx-auto mt-2 max-w-[55ch] text-sm text-[var(--text-secondary)]">
            {error?.error} Mission Control did not create sample transactions or report a successful review.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {error?.retryable && (
              <Button onClick={() => void startSession(mode, filters, true)}>Try again</Button>
            )}
            {error?.code === 'review_session_expired' && (
              <Button onClick={() => void startSession(mode, filters, false)}>Start new session</Button>
            )}
            <Button asChild variant="secondary"><Link href="/finance">Back to Finance</Link></Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-primary)]">
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-start justify-between gap-4">
          <div className="min-w-0">
            <Link href="/finance" className="mb-1 inline-flex min-h-8 items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              <ArrowLeft className="size-3.5" /> Finance overview
            </Link>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Finance quick review</h1>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Tyrion ranks and explains. You decide. Monarch remains the system of record.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFilterOpen((open) => !open)}
            aria-expanded={filterOpen}
            aria-controls="finance-review-filters"
          >
            <Filter /> Filters
          </Button>
        </div>
      </header>

      {!online && (
        <div role="alert" className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs text-amber-200">
          <CloudOff className="size-4" />
          You are offline. Your place is saved; actions resume when the connection returns.
        </div>
      )}

      <section
        id="finance-review-filters"
        hidden={!filterOpen}
        className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 sm:px-6"
      >
        <div className="mx-auto grid max-w-7xl gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <div className="flex gap-2" role="group" aria-label="Review mode">
              {(['ranked', 'period'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    'min-h-10 rounded-lg border px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                    mode === value
                      ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--text-primary)]'
                      : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)]',
                  )}
                >
                  {value === 'ranked' ? 'Ranked queue' : 'Review a period'}
                </button>
              ))}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <div className="text-xs text-[var(--text-secondary)]">
                <span id="finance-review-ranking-label">Ranking</span>
                <Select
                  value={filters.preset}
                  onValueChange={(value) => setFilters((current) => ({
                    ...current,
                    preset: value as FinanceReviewFilters['preset'],
                  }))}
                >
                  <SelectTrigger
                    aria-labelledby="finance-review-ranking-label"
                    className="mt-1 w-full bg-[var(--surface-1)]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESETS.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="text-xs text-[var(--text-secondary)]">
                Start date
                <input
                  type="date"
                  value={filters.startDate ?? ''}
                  onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value || null }))}
                  className="mt-1 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-primary)]"
                />
              </label>
              <label className="text-xs text-[var(--text-secondary)]">
                End date
                <input
                  type="date"
                  value={filters.endDate ?? ''}
                  onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value || null }))}
                  className="mt-1 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-primary)]"
                />
              </label>
              <label className="text-xs text-[var(--text-secondary)]">
                Minimum amount
                <input
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={filters.minimumAmount ?? ''}
                  onChange={(event) => setFilters((current) => ({
                    ...current,
                    minimumAmount: event.target.value ? Number(event.target.value) : null,
                  }))}
                  className="mt-1 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-primary)]"
                />
              </label>
              <label className="text-xs text-[var(--text-secondary)]">
                Maximum amount
                <input
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={filters.maximumAmount ?? ''}
                  onChange={(event) => setFilters((current) => ({
                    ...current,
                    maximumAmount: event.target.value ? Number(event.target.value) : null,
                  }))}
                  className="mt-1 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-primary)]"
                />
              </label>
            </div>
            {(session?.accounts.length ?? 0) > 0 && (
              <fieldset className="mt-3">
                <legend className="text-xs text-[var(--text-secondary)]">Accounts</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {session!.accounts.map((account) => {
                    const selected = filters.accountNames.includes(account);
                    return (
                      <button
                        key={account}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setFilters((current) => ({
                          ...current,
                          accountNames: selected
                            ? current.accountNames.filter((name) => name !== account)
                            : [...current.accountNames, account],
                        }))}
                        className={cn(
                          'min-h-10 rounded-full border px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                          selected
                            ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--text-primary)]'
                            : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)]',
                        )}
                      >
                        {account}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}
          </div>
          <Button
            className="self-end"
            disabled={mode === 'period' && (!filters.startDate || !filters.endDate)}
            onClick={() => void startSession(mode, filters, false)}
          >
            <SlidersHorizontal /> Apply and start new session
          </Button>
        </div>
      </section>

      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-2 sm:px-6">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
            <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${completion}%` }} />
          </div>
          <p className="shrink-0 text-xs tabular-nums text-[var(--text-secondary)]">
            {session?.progress.reviewed ?? 0} reviewed · {session?.progress.skipped ?? 0} skipped · {session?.progress.remaining ?? 0} left
          </p>
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">{status}</p>

      {!item ? (
        <main className="flex flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-md">
            <Check className="mx-auto size-8 text-emerald-400" />
            <h2 className="mt-3 text-lg font-semibold text-[var(--text-primary)]">Review complete</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              This session has no transactions left. Skipped items were counted only for this session.
            </p>
            <Button className="mt-4" onClick={() => void startSession(mode, filters, false)}>
              Start another session
            </Button>
          </div>
        </main>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid max-w-7xl gap-4 p-4 pb-28 sm:p-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:pb-6">
            <div className="space-y-4">
              <article className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
                <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] p-4 sm:p-5">
                  <div className="min-w-0">
                    <h2 className="truncate text-xl font-semibold text-[var(--text-primary)]">{item.payee}</h2>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">{item.accountName} · {new Date(`${item.date}T00:00:00`).toLocaleDateString()}</p>
                  </div>
                  <p className="shrink-0 text-xl font-semibold tabular-nums text-[var(--text-primary)]">{currency(item)}</p>
                </div>
                <dl className="grid grid-cols-2 divide-x divide-y divide-[var(--border)] sm:grid-cols-4 sm:divide-y-0">
                  <Fact label="Category" value={item.category?.label ?? 'Uncategorized'} />
                  <Fact label="Kids" value={item.kid?.label ?? 'Parent / unassigned'} />
                  <Fact
                    label="Monarch review"
                    value={item.monarchReview.status === 'unavailable'
                      ? 'Unavailable'
                      : item.monarchReview.status === 'needs-review'
                        ? `Needs review${item.monarchReview.assignedTo ? ` · Assigned to ${item.monarchReview.assignedTo}` : ''}`
                        : 'Reviewed'}
                  />
                  <Fact label="Overall confidence" value={confidenceLabel(item.confidence.overall)} />
                </dl>
                <section aria-labelledby="why-selected" className="border-t border-[var(--border)] p-4 sm:p-5">
                  <h3 id="why-selected" className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                    <CircleHelp className="size-4 text-amber-300" /> Why Tyrion selected this
                  </h3>
                  <ul className="mt-2 space-y-1.5">
                    {item.whySelected.map((reason) => (
                      <li key={reason} className="flex gap-2 text-sm text-[var(--text-secondary)]">
                        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-amber-300" aria-hidden="true" />
                        {reason}
                      </li>
                    ))}
                  </ul>
                </section>
              </article>

              {correcting && (
                <section aria-labelledby="correction-heading" className="rounded-xl border border-sky-400/30 bg-[var(--surface-1)] p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 id="correction-heading" className="text-base font-semibold text-[var(--text-primary)]">Correct transaction</h3>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">Mission Control writes each correction through to Monarch, then marks the transaction reviewed.</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setCorrecting(false)}>Cancel</Button>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <FieldSelect
                      label="Kids attribution"
                      value={draft.kidId}
                      onChange={(value) => setDraft((current) => ({ ...current, kidId: value }))}
                      options={[{ id: '', label: 'Parent / unassigned' }, ...item.corrections.kids]}
                    />
                    <FieldSelect
                      label="Category"
                      value={draft.categoryId}
                      onChange={(value) => setDraft((current) => ({ ...current, categoryId: value }))}
                      options={[
                        ...(item.category ? [] : [{ id: '', label: 'Uncategorized' }]),
                        ...item.corrections.categories,
                      ]}
                    />
                    <label className="text-xs text-[var(--text-secondary)] sm:col-span-2">
                      Payee
                      <input
                        list="payee-suggestions"
                        value={draft.payee}
                        maxLength={120}
                        onChange={(event) => setDraft((current) => ({ ...current, payee: event.target.value }))}
                        className="mt-1 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 text-sm text-[var(--text-primary)]"
                      />
                      <datalist id="payee-suggestions">
                        {item.corrections.payeeSuggestions.map((payee) => <option key={payee} value={payee} />)}
                      </datalist>
                    </label>
                  </div>
                  {item.corrections.maySuggestKidRule && draft.kidId && draft.kidId !== (item.kid?.id ?? '') && (
                    <section
                      aria-labelledby="merchant-rule-heading"
                      className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3 sm:p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h4 id="merchant-rule-heading" className="text-sm font-semibold text-[var(--text-primary)]">
                            Reusable merchant rule
                          </h4>
                          <p className="mt-1 max-w-[70ch] text-xs text-[var(--text-muted)]">
                            Previewing and creating a rule is separate from saving this transaction correction.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={rulePending || ruleCreatePending || !draft.payee.trim() || !online}
                          onClick={() => void previewRuleSuggestion()}
                        >
                          {rulePending ? <Loader2 className="motion-safe:animate-spin" /> : <Sparkles />}
                          {ruleSuggestion ? 'Refresh rule preview' : 'Preview reusable rule'}
                        </Button>
                      </div>

                      {ruleSuggestion && (
                        <div className="mt-4 space-y-4 border-t border-[var(--border)] pt-4">
                          <div className="rounded-lg bg-[var(--surface-1)] p-3">
                            <p className="text-xs font-medium text-[var(--text-primary)]">
                              Merchant pattern: <span className="break-words">{ruleSuggestion.merchantPattern}</span>
                            </p>
                            <p className="mt-1 text-xs text-[var(--text-muted)]">
                              This advisory has not been applied. Review every setting below, then explicitly create it.
                            </p>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="text-xs text-[var(--text-secondary)]">
                              <span id="merchant-rule-outcome-label">Outcome</span>
                              <Select
                                value={ruleOutcome}
                                onValueChange={(value) => setRuleOutcome(value as MerchantRuleOutcome)}
                              >
                                <SelectTrigger
                                  aria-labelledby="merchant-rule-outcome-label"
                                  className="mt-1 w-full bg-[var(--surface-1)]"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="kid">Assign to selected kid</SelectItem>
                                  <SelectItem value="parent-shared">Parent / shared expense</SelectItem>
                                  <SelectItem value="review">Send to review</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="text-xs text-[var(--text-secondary)]">
                              <span id="merchant-rule-confidence-label">Confidence</span>
                              <Select
                                value={ruleConfidence}
                                onValueChange={(value) => setRuleConfidence(value as 'definite' | 'likely')}
                              >
                                <SelectTrigger
                                  aria-labelledby="merchant-rule-confidence-label"
                                  className="mt-1 w-full bg-[var(--surface-1)]"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="likely">Likely</SelectItem>
                                  <SelectItem value="definite">Definite</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <label className="text-xs text-[var(--text-secondary)] sm:col-span-2">
                              Business entity pattern <span className="text-[var(--text-muted)]">(optional)</span>
                              <input
                                value={businessEntityPattern}
                                minLength={2}
                                maxLength={160}
                                onChange={(event) => setBusinessEntityPattern(event.target.value)}
                                placeholder="Example Holdings LLC"
                                className="mt-1 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 text-base text-[var(--text-primary)] sm:text-sm"
                              />
                            </label>
                          </div>

                          <fieldset>
                            <legend className="text-xs font-medium text-[var(--text-secondary)]">Scope</legend>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <label className="flex min-h-12 cursor-pointer items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs text-[var(--text-secondary)]">
                                <input
                                  type="radio"
                                  name="merchant-rule-scope"
                                  value="accounts"
                                  checked={ruleScope === 'accounts'}
                                  onChange={() => {
                                    setRuleScope('accounts');
                                    setGlobalScopeConfirmed(false);
                                  }}
                                />
                                <span>
                                  <strong className="block text-[var(--text-primary)]">Current account</strong>
                                  Applies only to the account for this transaction.
                                </span>
                              </label>
                              <label className="flex min-h-12 cursor-pointer items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
                                <input
                                  type="radio"
                                  name="merchant-rule-scope"
                                  value="global"
                                  checked={ruleScope === 'global'}
                                  onChange={() => setRuleScope('global')}
                                />
                                <span>
                                  <strong className="block text-amber-50">All accounts</strong>
                                  Applies to matching merchants across the household.
                                </span>
                              </label>
                            </div>
                          </fieldset>

                          {ruleScope === 'global' && (
                            <label className="flex items-start gap-2 rounded-lg border border-amber-300/40 bg-amber-300/10 p-3 text-xs text-amber-50">
                              <input
                                type="checkbox"
                                checked={globalScopeConfirmed}
                                onChange={(event) => setGlobalScopeConfirmed(event.target.checked)}
                              />
                              <span>
                                I understand this rule will apply to matching merchants on every household account.
                              </span>
                            </label>
                          )}

                          <Button
                            type="button"
                            disabled={
                              ruleCreatePending
                              || !online
                              || (ruleScope === 'global' && !globalScopeConfirmed)
                              || (businessEntityPattern.trim().length === 1)
                            }
                            onClick={() => void createMerchantRule()}
                          >
                            {ruleCreatePending ? <Loader2 className="motion-safe:animate-spin" /> : <ShieldCheck />}
                            Create confirmed rule
                          </Button>
                        </div>
                      )}

                      {createdRule && (
                        <div role="status" className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-xs text-emerald-100">
                          <strong className="block text-emerald-50">
                            {createdRule.outcome === 'replayed' ? 'Rule already created' : 'Rule created'}
                          </strong>
                          {createdRule.rule.pattern} is enabled for {
                            createdRule.rule.scope === 'global' ? 'all accounts' : 'this account'
                          }. The transaction correction has not been saved.
                        </div>
                      )}
                    </section>
                  )}
                  <Button className="mt-4 w-full sm:w-auto" disabled={!canCorrect || !!actionPending || !online} onClick={() => void applyAction('correct')}>
                    {actionPending === 'correct' ? <Loader2 className="motion-safe:animate-spin" /> : <WandSparkles />}
                    Save correction
                  </Button>
                </section>
              )}
            </div>

            <aside className="space-y-4">
              <section aria-labelledby="confidence-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
                <h3 id="confidence-heading" className="text-sm font-semibold text-[var(--text-primary)]">Confidence signals</h3>
                <div className="mt-3 space-y-3">
                  <Confidence label="Kids attribution" value={item.confidence.kids} />
                  <Confidence label="Category" value={item.confidence.category} />
                  <Confidence label="Payee" value={item.confidence.payee} />
                </div>
              </section>

              <section aria-labelledby="research-heading" className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
                <div className="flex items-start gap-2">
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-sky-300" />
                  <div>
                    <h3 id="research-heading" className="text-sm font-semibold text-[var(--text-primary)]">Vendor research</h3>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Public lookup defaults to normalized vendor name{item.research.coarseLocation ? ' and coarse location' : ''}.
                    </p>
                  </div>
                </div>
                {item.research.recommended && item.research.reason && (
                  <p className="mt-3 rounded-lg border border-sky-400/20 bg-sky-400/10 p-2.5 text-xs text-sky-200">
                    Tyrion recommends research: {item.research.reason}
                  </p>
                )}
                <label className="mt-2 flex min-h-10 items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={includeSensitiveContext}
                    onChange={(event) => setIncludeSensitiveContext(event.target.checked)}
                    className="size-4 rounded border-[var(--border)]"
                  />
                  Include amount and date when materially useful
                </label>
                <Button
                  variant="secondary"
                  className="mt-2 w-full"
                  disabled={researchPending || !online}
                  onClick={() => includeSensitiveContext ? setResearchDisclosureOpen(true) : void runResearch(false)}
                >
                  {researchPending ? <Loader2 className="motion-safe:animate-spin" /> : <Search />}
                  Research vendor
                </Button>
              </section>

              {research && <ResearchResult result={research} />}
            </aside>
          </div>
        </main>
      )}

      {item && (
        <div ref={actionRegionRef} className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-[var(--border)] bg-[var(--surface-0)]/95 p-3 shadow-[var(--shadow-lg)] backdrop-blur-sm sm:bottom-0 lg:static lg:shrink-0 lg:shadow-none">
          <div className="mx-auto grid max-w-3xl grid-cols-3 gap-2">
            <Button disabled={!!actionPending || !online} onClick={() => void applyAction('confirm')}>
              {actionPending === 'confirm' ? <Loader2 className="motion-safe:animate-spin" /> : <ShieldCheck />}
              <span>Confirm</span><kbd className="hidden text-[10px] opacity-70 sm:inline">C</kbd>
            </Button>
            <Button variant="secondary" disabled={!!actionPending || !online} onClick={() => setCorrecting(true)}>
              <WandSparkles /><span>Correct</span><kbd className="hidden text-[10px] opacity-70 sm:inline">X</kbd>
            </Button>
            <Button variant="ghost" disabled={!!actionPending || !online} onClick={() => void applyAction('skip')}>
              {actionPending === 'skip' ? <Loader2 className="motion-safe:animate-spin" /> : <SkipForward />}
              <span>Skip</span><kbd className="hidden text-[10px] opacity-70 sm:inline">S</kbd>
            </Button>
          </div>
        </div>
      )}

      {researchDisclosureOpen && item && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" role="presentation">
          <section role="alertdialog" aria-modal="true" aria-labelledby="research-disclosure-title" className="w-full max-w-lg rounded-t-2xl border border-[var(--border)] bg-[var(--surface-1)] p-5 shadow-[var(--shadow-lg)] sm:rounded-xl">
            <h2 id="research-disclosure-title" className="text-base font-semibold text-[var(--text-primary)]">Share amount and date for this lookup?</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              The public research request will include {currency(item)} and {new Date(`${item.date}T00:00:00`).toLocaleDateString()}. It will not include account/card details, transaction IDs, household identities, Kids identities, or transaction history.
            </p>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={() => setResearchDisclosureOpen(false)}>Cancel</Button>
              <Button variant="secondary" onClick={() => void runResearch(false)}>Research without amount/date</Button>
              <Button onClick={() => void runResearch(true)}>Share and research</Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 p-3">
      <dt className="text-[11px] font-medium text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

function Confidence({ label, value }: { label: string; value: number | null }) {
  const percent = value === null ? 0 : Math.round(value * 100);
  return (
    <div>
      <div className="flex justify-between gap-3 text-xs">
        <span className="text-[var(--text-secondary)]">{label}</span>
        <span className="tabular-nums text-[var(--text-primary)]">{confidenceLabel(value)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]">
        <div className={cn('h-full rounded-full', percent < 60 ? 'bg-amber-400' : 'bg-sky-400')} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const emptyValue = '__none__';

  return (
    <div className="text-xs text-[var(--text-secondary)]">
      <span id={`finance-review-${label.toLowerCase().replaceAll(' ', '-')}-label`}>{label}</span>
      <Select
        value={value || emptyValue}
        onValueChange={(nextValue) => onChange(nextValue === emptyValue ? '' : nextValue)}
      >
        <SelectTrigger
          aria-labelledby={`finance-review-${label.toLowerCase().replaceAll(' ', '-')}-label`}
          className="mt-1 w-full bg-[var(--surface-0)]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id || emptyValue} value={option.id || emptyValue}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ResearchResult({ result }: { result: FinanceVendorResearchResponse }) {
  const sources = new Map(result.sources.map((source) => [source.id, source]));
  return (
    <section aria-labelledby="research-result-heading" className="rounded-xl border border-sky-400/30 bg-[var(--surface-1)] p-4">
      <h3 id="research-result-heading" className="text-sm font-semibold text-[var(--text-primary)]">Research result</h3>
      <p className="mt-1 text-xs text-[var(--text-muted)]">Sourced facts are separated from inference. Research did not change this transaction.</p>
      {result.facts.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-emerald-300">Sourced facts</h4>
          <ul className="mt-2 space-y-2">
            {result.facts.map((fact) => (
              <li key={fact.statement} className="text-sm text-[var(--text-secondary)]">
                {fact.statement} <span className="text-xs tabular-nums text-[var(--text-muted)]">({Math.round(fact.confidence * 100)}%)</span>
                {fact.sourceIds.length > 0 && (
                  <span className="ml-1">
                    {fact.sourceIds.map((id) => sources.get(id)).filter(Boolean).map((source) => (
                      <a key={source!.id} href={source!.url} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-xs text-[var(--accent-400)] hover:underline">
                        {source!.publisher}<ExternalLink className="size-3" />
                      </a>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.inferences.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-sky-300">Inference</h4>
          <ul className="mt-2 space-y-2">
            {result.inferences.map((inference) => (
              <li key={inference.statement} className="text-sm text-[var(--text-secondary)]">
                {inference.statement} <span className="text-xs tabular-nums text-[var(--text-muted)]">({Math.round(inference.confidence * 100)}%)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {Object.values(result.suggestions).some((value) => (
        Array.isArray(value) ? value.length > 0 : value !== null
      )) && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-[var(--text-primary)]">Possible interpretation</h4>
          <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
            {result.suggestions.businessIdentity && <Suggestion label="Business" value={result.suggestions.businessIdentity} />}
            {result.suggestions.location && <Suggestion label="Location" value={result.suggestions.location} />}
            {result.suggestions.businessType && <Suggestion label="Type" value={result.suggestions.businessType} />}
            {result.suggestions.plausiblePurchase && <Suggestion label="Plausible purchase" value={result.suggestions.plausiblePurchase} />}
            {result.suggestions.category && <Suggestion label="Category" value={result.suggestions.category} />}
            {result.suggestions.kidsClues.length > 0 && <Suggestion label="Kids clues" value={result.suggestions.kidsClues.join(' · ')} />}
          </dl>
        </div>
      )}
      {result.riskIndicators.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-amber-200"><AlertTriangle className="size-3.5" /> Needs investigation</h4>
          <ul className="mt-2 space-y-1 text-xs text-amber-100">
            {result.riskIndicators.map((indicator) => <li key={indicator.detail}>{indicator.detail}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

function Suggestion({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}
