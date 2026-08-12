export const FINANCE_PROVIDER_ALIASES = [
  'finance',
  'finance-manager',
  'monarch-money',
] as const;

export type FinanceProviderAlias = typeof FINANCE_PROVIDER_ALIASES[number];

export function normalizeFinanceProviderAlias(value: string): 'finance-manager' | null {
  return FINANCE_PROVIDER_ALIASES.includes(value.trim().toLowerCase() as FinanceProviderAlias)
    ? 'finance-manager'
    : null;
}

export function financeProviderFilterValues(value: string): readonly string[] {
  return normalizeFinanceProviderAlias(value) ? FINANCE_PROVIDER_ALIASES : [value];
}

export function normalizeFinanceProviderFacets(
  rows: readonly { value: string | null; count: number }[],
): Record<string, number> {
  const facets: Record<string, number> = {};
  for (const row of rows) {
    if (!row.value) continue;
    const source = normalizeFinanceProviderAlias(row.value) ?? row.value;
    facets[source] = (facets[source] ?? 0) + Number(row.count);
  }
  return facets;
}
