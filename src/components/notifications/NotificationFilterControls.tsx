'use client';

import { X } from 'lucide-react';
import { useRef } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { NotificationFacets } from '@/lib/hooks/useNotifications';
import {
  DEFAULT_NOTIFICATION_QUERY,
  type NotificationQuery,
} from '@/lib/notifications/query';
import { cn } from '@/lib/utils';

const ALL_OPTIONS_VALUE = '__all__';

const CATEGORY_LABELS: Record<string, string> = {
  ai_insights: 'AI Insights',
  finance: 'Finance',
  home: 'Home',
  packages: 'Packages',
  social: 'Social',
  system: 'System',
  tasks: 'Tasks',
};

function formatLabel(value: string): string {
  return value
    .split(/[-_]+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function categoryLabel(value: string): string {
  return CATEGORY_LABELS[value] ?? formatLabel(value);
}

function optionValues(
  facets: Record<string, number>,
  selected: string | null,
  required: readonly string[] = [],
): string[] {
  return [...new Set([
    ...required,
    ...Object.keys(facets),
    ...(selected ? [selected] : []),
  ])].sort((left, right) => categoryLabel(left).localeCompare(categoryLabel(right)));
}

export interface ActiveNotificationFilter {
  key: keyof NotificationQuery;
  label: string;
}

export function activeNotificationFilters(
  query: NotificationQuery,
  facets: NotificationFacets,
): ActiveNotificationFilter[] {
  const merchantLabel = facets.merchant.find(facet => facet.key === query.merchant)?.label;
  const filters: ActiveNotificationFilter[] = [];
  if (query.q) filters.push({ key: 'q', label: `Search: ${query.q}` });
  if (query.level) filters.push({ key: 'level', label: `Level: ${formatLabel(query.level)}` });
  if (query.category) {
    filters.push({ key: 'category', label: `Category: ${categoryLabel(query.category)}` });
  }
  if (query.merchant) {
    filters.push({
      key: 'merchant',
      label: `Merchant: ${merchantLabel ?? 'Unavailable merchant'}`,
    });
  }
  if (query.source) filters.push({ key: 'source', label: `Source: ${formatLabel(query.source)}` });
  if (query.sourceAccount) {
    filters.push({ key: 'sourceAccount', label: `Source account: ${query.sourceAccount}` });
  }
  if (query.state) filters.push({ key: 'state', label: `State: ${formatLabel(query.state)}` });
  if (query.actionableOnly) filters.push({ key: 'actionableOnly', label: 'Actionable only' });
  if (query.dateRange) filters.push({ key: 'dateRange', label: `Time: ${formatLabel(query.dateRange)}` });
  if (query.repository) filters.push({ key: 'repository', label: `Repository: ${query.repository}` });
  if (query.owner) filters.push({ key: 'owner', label: `Owner: ${query.owner}` });
  if (query.reason) filters.push({ key: 'reason', label: `Reason: ${formatLabel(query.reason)}` });
  if (query.subjectType) {
    filters.push({ key: 'subjectType', label: `Subject type: ${query.subjectType}` });
  }
  if (query.participating) filters.push({ key: 'participating', label: 'Participating only' });
  return filters;
}

export function clearNotificationFilter(
  query: NotificationQuery,
  key: keyof NotificationQuery,
): NotificationQuery {
  if (key === 'actionableOnly' || key === 'participating') {
    return { ...query, [key]: false };
  }
  if (key === 'sort') return { ...query, sort: 'newest' };
  return { ...query, [key]: null };
}

interface NotificationFilterControlsProps {
  query: NotificationQuery;
  facets: NotificationFacets;
  onChange: (query: NotificationQuery) => void;
  touchTargets?: boolean;
}

export function NotificationFilterControls({
  query,
  facets,
  onChange,
  touchTargets = false,
}: NotificationFilterControlsProps) {
  const categoryControlRef = useRef<HTMLButtonElement>(null);
  const sourceControlRef = useRef<HTMLButtonElement>(null);
  const merchantControlRef = useRef<HTMLButtonElement>(null);
  const activeFilters = activeNotificationFilters(query, facets);
  const categories = optionValues(facets.category, query.category, ['finance']);
  const sources = optionValues(facets.source, query.source);
  const selectedMerchant = facets.merchant.find(facet => facet.key === query.merchant);
  const merchants = selectedMerchant || !query.merchant
    ? facets.merchant
    : [{ key: query.merchant, label: 'Unavailable merchant', count: 0 }, ...facets.merchant];
  const controlClassName = cn(
    'min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs text-[var(--text-primary)]',
    touchTargets ? 'min-h-[44px]' : 'h-8',
  );
  const focusControlForFilter = (key: keyof NotificationQuery) => {
    if (key === 'source') return sourceControlRef.current;
    if (key === 'merchant') return merchantControlRef.current;
    return categoryControlRef.current;
  };
  const clearFilter = (key: keyof NotificationQuery) => {
    onChange(clearNotificationFilter(query, key));
    focusControlForFilter(key)?.focus();
  };
  const clearAllFilters = () => {
    onChange({ ...DEFAULT_NOTIFICATION_QUERY, sort: query.sort });
    categoryControlRef.current?.focus();
  };

  return (
    <section aria-label="Notification filter controls" className="mt-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="min-w-0">
          <Select
            value={query.category ?? ALL_OPTIONS_VALUE}
            onValueChange={value => onChange({
              ...query,
              category: value === ALL_OPTIONS_VALUE ? null : value,
            })}
          >
            <SelectTrigger
              ref={categoryControlRef}
              aria-label="Category filter"
              className={cn(controlClassName, 'w-full')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_OPTIONS_VALUE}>All categories</SelectItem>
              {categories.map(value => (
                <SelectItem key={value} value={value}>
                  {categoryLabel(value)} ({facets.category[value] ?? 0})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0">
          <Select
            value={query.source ?? ALL_OPTIONS_VALUE}
            onValueChange={value => onChange({
              ...query,
              source: value === ALL_OPTIONS_VALUE ? null : value,
            })}
          >
            <SelectTrigger
              ref={sourceControlRef}
              aria-label="Source filter"
              className={cn(controlClassName, 'w-full')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_OPTIONS_VALUE}>All sources</SelectItem>
              {sources.map(value => (
                <SelectItem key={value} value={value}>
                  {formatLabel(value)} ({facets.source[value] ?? 0})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0">
          <Select
            value={query.merchant ?? ALL_OPTIONS_VALUE}
            onValueChange={value => onChange({
              ...query,
              merchant: value === ALL_OPTIONS_VALUE ? null : value,
            })}
          >
            <SelectTrigger
              ref={merchantControlRef}
              aria-label="Merchant filter"
              className={cn(controlClassName, 'w-full')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_OPTIONS_VALUE}>All merchants</SelectItem>
              {merchants.map(facet => (
                <SelectItem key={facet.key} value={facet.key}>
                  {facet.label} ({facet.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {activeFilters.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Applied notification filters">
          <span className="text-xs font-medium text-[var(--text-secondary)]" aria-live="polite">
            {activeFilters.length} {activeFilters.length === 1 ? 'filter' : 'filters'} applied
          </span>
          {activeFilters.map(filter => (
            <button
              key={filter.key}
              type="button"
              onClick={() => clearFilter(filter.key)}
              aria-label={`Clear ${filter.label} filter`}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                touchTargets ? 'min-h-[44px]' : 'min-h-7',
              )}
            >
              {filter.label}
              <X size={12} aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAllFilters}
            className={cn(
              'rounded-md px-2 text-xs font-medium text-[var(--accent)] underline',
              touchTargets ? 'min-h-[44px]' : 'min-h-7',
            )}
          >
            Clear all filters
          </button>
        </div>
      )}
    </section>
  );
}
