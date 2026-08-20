'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Building2,
  Check,
  ChevronRight,
  CircleUserRound,
  FolderGit2,
  GitPullRequest,
  Layers3,
  ListFilter,
  Plus,
  Search,
  Tag,
  UserRoundCheck,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Dropdown } from '@/components/ui/Dropdown';
import type { NotificationFacets } from '@/lib/hooks/useNotifications';
import {
  DEFAULT_NOTIFICATION_QUERY,
  type NotificationQuery,
} from '@/lib/notifications/query';
import {
  formatNotificationCategoryLabel,
  formatNotificationSourceLabel,
} from '@/lib/notifications/categories';
import { cn } from '@/lib/utils';

type BuilderFilterKey =
  | 'category'
  | 'merchant'
  | 'source'
  | 'repository'
  | 'owner'
  | 'reason'
  | 'subjectType'
  | 'sourceAccount'
  | 'participating'
  | 'actionableOnly';

interface FilterDefinition {
  key: BuilderFilterKey;
  label: string;
  icon: LucideIcon;
  kind: 'options' | 'text' | 'boolean';
  common?: boolean;
}

interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

const FILTER_DEFINITIONS: FilterDefinition[] = [
  { key: 'category', label: 'Category', icon: Layers3, kind: 'options' },
  { key: 'merchant', label: 'Merchant', icon: Building2, kind: 'options' },
  { key: 'repository', label: 'Repository', icon: FolderGit2, kind: 'text' },
  { key: 'owner', label: 'Owner', icon: CircleUserRound, kind: 'text' },
  { key: 'reason', label: 'Reason', icon: GitPullRequest, kind: 'text' },
  { key: 'subjectType', label: 'Subject type', icon: Tag, kind: 'text' },
  { key: 'sourceAccount', label: 'Source account', icon: UserRoundCheck, kind: 'text' },
  { key: 'participating', label: 'Participating only', icon: UserRoundCheck, kind: 'boolean' },
  { key: 'actionableOnly', label: 'Actionable only', icon: Zap, kind: 'boolean' },
  { key: 'source', label: 'Source', icon: ListFilter, kind: 'options', common: true },
];

function formatLabel(value: string): string {
  return value
    .split(/[-_]+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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
    filters.push({
      key: 'category',
      label: `Category: ${formatNotificationCategoryLabel(query.category)}`,
    });
  }
  if (query.merchant) {
    filters.push({
      key: 'merchant',
      label: `Merchant: ${merchantLabel ?? 'Unavailable merchant'}`,
    });
  }
  if (query.source) {
    filters.push({
      key: 'source',
      label: `Source: ${formatNotificationSourceLabel(query.source)}`,
    });
  }
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
  desktopInline?: boolean;
  includeCommonFilters?: boolean;
}

export function NotificationFilterControls({
  query,
  facets,
  onChange,
  touchTargets = false,
  desktopInline = false,
  includeCommonFilters = true,
}: NotificationFilterControlsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<BuilderFilterKey | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeFilters = activeNotificationFilters(query, facets);
  const definitions = useMemo(
    () => FILTER_DEFINITIONS.filter(definition => (
      includeCommonFilters || !definition.common
    )),
    [includeCommonFilters],
  );
  const selectedDefinition = definitions.find(definition => definition.key === selectedKey);
  const normalizedSearch = search.trim().toLowerCase();
  const visibleDefinitions = definitions.filter(definition => (
    !normalizedSearch || definition.label.toLowerCase().includes(normalizedSearch)
  ));
  const options = selectedKey ? filterOptions(selectedKey, query, facets) : [];
  const visibleOptions = options.filter(option => (
    !normalizedSearch || option.label.toLowerCase().includes(normalizedSearch)
  ));

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      setSelectedKey(null);
      setSearch('');
      setDraft('');
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  function closeBuilder() {
    setIsOpen(false);
    setSelectedKey(null);
    setSearch('');
    setDraft('');
  }

  function selectDefinition(definition: FilterDefinition) {
    if (definition.kind === 'boolean') {
      if (definition.key === 'participating') {
        onChange({ ...query, participating: !query.participating });
      } else if (definition.key === 'actionableOnly') {
        onChange({ ...query, actionableOnly: !query.actionableOnly });
      }
      closeBuilder();
      triggerRef.current?.focus();
      return;
    }
    setSelectedKey(definition.key);
    setSearch('');
    setDraft(String(query[definition.key] ?? ''));
  }

  function applyOption(value: string) {
    if (selectedKey === 'category') onChange({ ...query, category: value });
    else if (selectedKey === 'merchant') onChange({ ...query, merchant: value });
    else if (selectedKey === 'source') onChange({ ...query, source: value });
    else return;
    closeBuilder();
    triggerRef.current?.focus();
  }

  function applyText(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    if (selectedKey === 'repository') onChange({ ...query, repository: value });
    else if (selectedKey === 'owner') onChange({ ...query, owner: value });
    else if (selectedKey === 'reason') onChange({ ...query, reason: value });
    else if (selectedKey === 'subjectType') onChange({ ...query, subjectType: value });
    else if (selectedKey === 'sourceAccount') onChange({ ...query, sourceAccount: value });
    else return;
    closeBuilder();
    triggerRef.current?.focus();
  }

  function clearFilter(key: keyof NotificationQuery) {
    onChange(clearNotificationFilter(query, key));
    triggerRef.current?.focus();
  }

  function clearAllFilters() {
    onChange({ ...DEFAULT_NOTIFICATION_QUERY, sort: query.sort });
    triggerRef.current?.focus();
  }

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]',
        touchTargets ? 'min-h-[44px]' : 'h-8',
      )}
    >
      <Plus size={13} className="text-[var(--accent-400)]" aria-hidden="true" />
      Add filter
    </button>
  );

  return (
    <section
      aria-label="Notification filter controls"
      className={desktopInline ? 'contents' : 'mt-2'}
    >
      <Dropdown
        trigger={trigger}
        isOpen={isOpen}
        onOpenChange={open => {
          setIsOpen(open);
          if (!open) {
            setSelectedKey(null);
            setSearch('');
            setDraft('');
          }
        }}
        align={desktopInline ? 'right' : 'left'}
        width="w-72"
        role="dialog"
        ariaLabel={selectedDefinition
          ? `Set ${selectedDefinition.label} notification filter`
          : 'Add a notification filter'}
        className="p-1.5"
      >
        {selectedDefinition ? (
          <>
            <div className="flex items-center gap-2 px-1 py-1">
              <button
                type="button"
                onClick={() => {
                  setSelectedKey(null);
                  setSearch('');
                  setDraft('');
                }}
                className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
                aria-label="Back to notification filter types"
              >
                <ArrowLeft size={14} />
              </button>
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                {selectedDefinition.label}
              </span>
            </div>
            {selectedDefinition.kind === 'options' ? (
              <>
                <FilterSearch
                  value={search}
                  onChange={setSearch}
                  placeholder={`Search ${selectedDefinition.label.toLowerCase()}…`}
                />
                <div className="max-h-64 overflow-y-auto py-1">
                  {visibleOptions.map(option => (
                    <button
                      type="button"
                      key={option.value}
                      onClick={() => applyOption(option.value)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs',
                        query[selectedDefinition.key] === option.value
                          ? 'bg-[var(--accent)]/10 text-[var(--accent-300)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      <span className="flex-1 truncate">{option.label}</span>
                      {option.count !== undefined && (
                        <span className="text-xs tabular-nums text-[var(--text-muted)]">
                          {option.count}
                        </span>
                      )}
                      {query[selectedDefinition.key] === option.value && (
                        <Check size={13} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                  {visibleOptions.length === 0 && (
                    <p className="px-3 py-5 text-center text-xs text-[var(--text-muted)]">
                      No matching values
                    </p>
                  )}
                </div>
              </>
            ) : (
              <form onSubmit={applyText} className="flex gap-1.5 p-1 pt-2">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">{selectedDefinition.label}</span>
                  <input
                    autoFocus
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                    placeholder={`Enter ${selectedDefinition.label.toLowerCase()}`}
                    className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
                  />
                </label>
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className="rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Add
                </button>
              </form>
            )}
          </>
        ) : (
          <>
            <FilterSearch value={search} onChange={setSearch} placeholder="Search filters…" />
            <div className="py-1">
              {visibleDefinitions.map(definition => {
                const Icon = definition.icon;
                const selected = Boolean(query[definition.key]);
                return (
                  <button
                    type="button"
                    key={definition.key}
                    onClick={() => selectDefinition(definition)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
                  >
                    <Icon size={14} className="text-[var(--text-muted)]" aria-hidden="true" />
                    <span className="flex-1">{definition.label}</span>
                    {definition.kind === 'boolean' && selected ? (
                      <Check size={13} className="text-[var(--accent)]" aria-hidden="true" />
                    ) : (
                      definition.kind !== 'boolean'
                        ? <ChevronRight size={13} className="text-[var(--text-muted)]" aria-hidden="true" />
                        : null
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Dropdown>

      {activeFilters.length > 0 && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-1.5',
            desktopInline ? 'order-10 basis-full pt-1' : 'mt-2',
          )}
          aria-label="Applied notification filters"
        >
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

function FilterSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="relative m-1 block">
      <Search
        size={13}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
        aria-hidden="true"
      />
      <span className="sr-only">{placeholder}</span>
      <input
        type="search"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] py-1.5 pl-8 pr-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
      />
    </label>
  );
}

function filterOptions(
  key: BuilderFilterKey,
  query: NotificationQuery,
  facets: NotificationFacets,
): FilterOption[] {
  if (key === 'category') {
    return uniqueValues(Object.keys(facets.category), query.category)
      .map(value => ({
        value,
        label: formatNotificationCategoryLabel(value),
        count: facets.category[value] ?? 0,
      }));
  }
  if (key === 'source') {
    return uniqueValues(Object.keys(facets.source), query.source)
      .map(value => ({
        value,
        label: formatNotificationSourceLabel(value),
        count: facets.source[value] ?? 0,
      }));
  }
  if (key === 'merchant') {
    const selectedMerchant = facets.merchant.find(facet => facet.key === query.merchant);
    return [
      ...(!selectedMerchant && query.merchant
        ? [{ value: query.merchant, label: 'Unavailable merchant', count: 0 }]
        : []),
      ...facets.merchant.map(facet => ({
        value: facet.key,
        label: facet.label,
        count: facet.count,
      })),
    ];
  }
  return [];
}

function uniqueValues(values: string[], selected: string | null): string[] {
  return [...new Set([...values, ...(selected ? [selected] : [])])]
    .sort((left, right) => formatLabel(left).localeCompare(formatLabel(right)));
}
