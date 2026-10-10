import { createHash } from 'node:crypto';

export const ATTRIBUTION_ATTENTION_POLICY_SETTING = 'attributionAttention';
export const DEFAULT_ATTRIBUTION_PENDING_COUNT_THRESHOLD = 10;
export const DEFAULT_ATTRIBUTION_HIGH_AMOUNT_MAJOR = 250;
export const MAX_ATTRIBUTION_PENDING_COUNT_THRESHOLD = 100_000;
export const MAX_ATTRIBUTION_HIGH_AMOUNT_MINOR = 1_000_000_000_000;

export interface AttributionAttentionAccountOverride {
  pendingCountThreshold: number | null;
  highAmountThresholdMinor: number | null;
}

export interface AttributionAttentionPolicy {
  pendingCountThreshold: number;
  highAmountThresholdMinor: number;
  accountOverrides: Record<string, AttributionAttentionAccountOverride>;
}

export class AttributionAttentionPolicyError extends Error {
  constructor(readonly code = 'attribution_attention_policy_invalid') {
    super(code);
    this.name = 'AttributionAttentionPolicyError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function currencyMinorUnitFactor(currency: string): number {
  const digits = new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
  }).resolvedOptions().maximumFractionDigits;
  return 10 ** (digits ?? 2);
}

export function attributionAttentionAccountRef(
  connectorId: string,
  directAccountId: string,
): string {
  return `account-v1:${createHash('sha256')
    .update(`${connectorId}\0${directAccountId}`)
    .digest('hex')}`;
}

export function isAttributionAttentionAccountRef(value: string): boolean {
  return /^account-v1:[a-f0-9]{64}$/.test(value);
}

function boundedInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new AttributionAttentionPolicyError();
  }
  return Number(value);
}

export function parseAttributionAttentionPolicy(
  settings: unknown,
  currency: string,
): AttributionAttentionPolicy {
  const settingsRecord = record(settings);
  const raw = settingsRecord[ATTRIBUTION_ATTENTION_POLICY_SETTING];
  const defaultAmount = DEFAULT_ATTRIBUTION_HIGH_AMOUNT_MAJOR * currencyMinorUnitFactor(currency);
  if (raw === undefined) {
    return {
      pendingCountThreshold: DEFAULT_ATTRIBUTION_PENDING_COUNT_THRESHOLD,
      highAmountThresholdMinor: defaultAmount,
      accountOverrides: {},
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AttributionAttentionPolicyError();
  }
  const policy = raw as Record<string, unknown>;
  const overridesValue = policy.accountOverrides ?? {};
  if (
    overridesValue === null
    || typeof overridesValue !== 'object'
    || Array.isArray(overridesValue)
  ) {
    throw new AttributionAttentionPolicyError();
  }
  const accountOverrides: Record<string, AttributionAttentionAccountOverride> = {};
  for (const [accountRef, value] of Object.entries(overridesValue)) {
    if (
      !isAttributionAttentionAccountRef(accountRef)
      || value === null
      || typeof value !== 'object'
      || Array.isArray(value)
    ) {
      throw new AttributionAttentionPolicyError();
    }
    const override = record(value);
    const countValue = override.pendingCountThreshold;
    const amountValue = override.highAmountThresholdMinor;
    accountOverrides[accountRef] = {
      pendingCountThreshold: countValue === null || countValue === undefined
        ? null
        : boundedInteger(countValue, MAX_ATTRIBUTION_PENDING_COUNT_THRESHOLD),
      highAmountThresholdMinor: amountValue === null || amountValue === undefined
        ? null
        : boundedInteger(amountValue, MAX_ATTRIBUTION_HIGH_AMOUNT_MINOR),
    };
  }
  return {
    pendingCountThreshold: policy.pendingCountThreshold === undefined
      ? DEFAULT_ATTRIBUTION_PENDING_COUNT_THRESHOLD
      : boundedInteger(
          policy.pendingCountThreshold,
          MAX_ATTRIBUTION_PENDING_COUNT_THRESHOLD,
        ),
    highAmountThresholdMinor: policy.highAmountThresholdMinor === undefined
      ? defaultAmount
      : boundedInteger(
          policy.highAmountThresholdMinor,
          MAX_ATTRIBUTION_HIGH_AMOUNT_MINOR,
        ),
    accountOverrides,
  };
}

export function resolveAttributionAttentionThresholds(
  policy: AttributionAttentionPolicy,
  accountRef: string,
): Pick<AttributionAttentionPolicy, 'pendingCountThreshold' | 'highAmountThresholdMinor'> {
  const override = policy.accountOverrides[accountRef];
  return {
    pendingCountThreshold:
      override?.pendingCountThreshold ?? policy.pendingCountThreshold,
    highAmountThresholdMinor:
      override?.highAmountThresholdMinor ?? policy.highAmountThresholdMinor,
  };
}
