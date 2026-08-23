'use client';

import type {
  DashboardProjectViewModel as HubProject,
} from '@/types/dashboard';
import {
  parseFilterQuery,
  removeFilterQueryToken,
} from '@/lib/utils/parseFilterQuery';
import {
  FILTER_TOKEN_STYLES,
  getFilterTokenDisplayValue,
} from '@/components/filters/filter-token-display';

interface EmptyStateQueryFiltersProps {
  query: string;
  projects: HubProject[];
  onQueryChange: (query: string) => void;
}

export function EmptyStateQueryFilters({
  query,
  projects,
  onQueryChange,
}: EmptyStateQueryFiltersProps) {
  const tokens = parseFilterQuery(query).tokens;

  return tokens.map((token, index) => {
    const style = token.negated
      ? { bg: 'bg-red-500/15', text: 'text-red-300', border: 'border-red-500/30' }
      : FILTER_TOKEN_STYLES[token.type];
    const label = token.type === 'text'
      ? getFilterTokenDisplayValue(token, projects)
      : `${token.negated ? '-' : ''}${token.type}: ${getFilterTokenDisplayValue(token, projects)}`;

    return (
      <span
        key={`${token.raw}-${index}`}
        className={`px-2 py-0.5 rounded-full text-xs border flex items-center gap-1 ${style.bg} ${style.text} ${style.border}`}
      >
        {label}
        <button
          type="button"
          onClick={() => onQueryChange(removeFilterQueryToken(query, index, token))}
          className="ml-1 hover:text-white"
          aria-label={`Remove ${token.type}:${token.value} filter`}
        >
          ×
        </button>
      </span>
    );
  });
}
