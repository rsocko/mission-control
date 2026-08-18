'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUserRound,
  Flag,
  FolderKanban,
  List,
  Plus,
  Search,
  Tag,
  Unplug,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Dropdown } from '@/components/ui/Dropdown';
import type { FilterToken, FilterTokenType } from '@/lib/utils/parseFilterQuery';
import type {
  DashboardProjectViewModel as HubProject,
  DashboardTaskTagViewModel as TaskTag,
  EnabledSource,
  SourceList,
} from '@/types/dashboard';
import { PRIORITY_LABELS, STATUS_LABELS } from '@/types/dashboard';

export type TaskFilterBuilderCategory = Exclude<FilterTokenType, 'title' | 'text' | 'listid'>;

interface TaskFilterBuilderProps {
  tokens: FilterToken[];
  sources: EnabledSource[];
  sourceLists: SourceList[];
  tags: TaskTag[];
  assignees: string[];
  projects: HubProject[];
  hiddenCategories?: TaskFilterBuilderCategory[];
  onToggleToken: (type: TaskFilterBuilderCategory, value: string, negated: boolean) => void;
}

interface CategoryDefinition {
  type: TaskFilterBuilderCategory;
  label: string;
  icon: LucideIcon;
}

interface FilterOption {
  value: string;
  label: string;
  detail?: string;
}

const CATEGORIES: CategoryDefinition[] = [
  { type: 'assignee', label: 'Assignee', icon: CircleUserRound },
  { type: 'tag', label: 'Tag', icon: Tag },
  { type: 'priority', label: 'Priority', icon: Zap },
  { type: 'status', label: 'Status', icon: Check },
  { type: 'source', label: 'Source', icon: Unplug },
  { type: 'list', label: 'List', icon: List },
  { type: 'project', label: 'Project', icon: FolderKanban },
  { type: 'phase', label: 'Phase', icon: Flag },
  { type: 'due', label: 'Due Date', icon: CalendarDays },
];

const DUE_OPTIONS: FilterOption[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'none', label: 'No due date' },
];

export function TaskFilterBuilder({
  tokens,
  sources,
  sourceLists,
  tags,
  assignees,
  projects,
  hiddenCategories = [],
  onToggleToken,
}: TaskFilterBuilderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [category, setCategory] = useState<TaskFilterBuilderCategory | null>(null);
  const [search, setSearch] = useState('');
  const [exclude, setExclude] = useState(false);
  const [dateOperator, setDateOperator] = useState<'<' | '>' | null>(null);
  const [date, setDate] = useState('');

  const options = useMemo(
    () => getOptions(category, sources, sourceLists, tags, assignees, projects),
    [category, sources, sourceLists, tags, assignees, projects]
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filteredCategories = CATEGORIES.filter(({ type, label }) =>
    !hiddenCategories.includes(type) && label.toLowerCase().includes(normalizedSearch)
  );
  const filteredOptions = options.filter(({ label, detail }) =>
    !normalizedSearch
    || label.toLowerCase().includes(normalizedSearch)
    || detail?.toLowerCase().includes(normalizedSearch)
  );
  const currentCategory = CATEGORIES.find((item) => item.type === category);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  function handleOpenChange(open: boolean) {
    setIsOpen(open);
    if (!open) resetPicker();
  }

  function resetPicker() {
    setCategory(null);
    setSearch('');
    setExclude(false);
    setDateOperator(null);
    setDate('');
  }

  function selectCategory(type: TaskFilterBuilderCategory | null) {
    setCategory(type);
    setSearch('');
    setDateOperator(null);
  }

  function isSelected(value: string) {
    return tokens.some(
      (token) => token.type === category && token.value === value && token.negated === exclude
    );
  }

  function toggleValue(value: string) {
    if (!category) return;
    onToggleToken(category, value, exclude);
  }

  const trigger = (
    <button
      type="button"
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      className="h-full min-h-9 inline-flex items-center gap-1.5 px-3 rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors whitespace-nowrap"
    >
      <Plus size={13} className="text-[var(--accent-400)]" />
      Add Filter
    </button>
  );

  return (
    <Dropdown
      trigger={trigger}
      isOpen={isOpen}
      onOpenChange={handleOpenChange}
      align="right"
      width="w-72"
      role="dialog"
      ariaLabel={category ? `Select ${currentCategory?.label} filter` : 'Add a task filter'}
      className="p-1.5"
    >
      {category ? (
        <>
          <div className="flex items-center gap-2 px-1 py-1">
            <button
              type="button"
              onClick={() => selectCategory(null)}
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]"
              aria-label="Back to filter categories"
            >
              <ArrowLeft size={14} />
            </button>
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              {currentCategory?.label}
            </span>
            <button
              type="button"
              onClick={() => setExclude((value) => !value)}
              className={`ml-auto px-2 py-1 rounded border text-[10px] font-medium ${
                exclude
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
              aria-pressed={exclude}
            >
              {exclude ? 'Excluding' : 'Including'}
            </button>
          </div>

          {category !== 'due' && (
            <FilterSearch
              value={search}
              onChange={setSearch}
              placeholder={`Search ${currentCategory?.label.toLowerCase()}…`}
            />
          )}

          <div className="max-h-64 overflow-y-auto py-1">
            {filteredOptions.map((option) => {
              const selected = isSelected(option.value);
              return (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => toggleValue(option.value)}
                  className={`w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs ${
                    selected
                      ? exclude
                        ? 'bg-red-500/10 text-red-300'
                        : 'bg-[var(--accent)]/10 text-[var(--accent-300)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span className="flex-1 truncate">{option.label}</span>
                  {option.detail && (
                    <span className="text-[10px] text-[var(--text-muted)] truncate">
                      {option.detail}
                    </span>
                  )}
                  {selected && <Check size={13} aria-hidden="true" />}
                </button>
              );
            })}
            {filteredOptions.length === 0 && category !== 'due' && (
              <p className="px-3 py-5 text-center text-xs text-[var(--text-muted)]">
                No matching values
              </p>
            )}
          </div>

          {category === 'due' && (
            <div className="border-t border-[var(--border-subtle)] pt-1">
              <div className="grid grid-cols-2 gap-1">
                {([
                  ['<', 'Before date'],
                  ['>', 'After date'],
                ] as const).map(([operator, label]) => (
                  <button
                    type="button"
                    key={operator}
                    onClick={() => setDateOperator(operator)}
                    className={`rounded-md px-2 py-1.5 text-xs ${
                      dateOperator === operator
                        ? 'bg-[var(--surface-3)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {dateOperator && (
                <div className="flex gap-1.5 p-1 pt-2">
                  <input
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]"
                    aria-label={`${dateOperator === '<' ? 'Before' : 'After'} date`}
                  />
                  <button
                    type="button"
                    disabled={!date}
                    onClick={() => {
                      if (date) toggleValue(`${dateOperator}${date}`);
                    }}
                    className="rounded-md bg-[var(--accent)] px-2.5 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <FilterSearch value={search} onChange={setSearch} placeholder="Search filters…" />
          <div className="py-1">
            {filteredCategories.map(({ type, label, icon: Icon }) => (
              <button
                type="button"
                key={type}
                onClick={() => selectCategory(type)}
                className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]"
              >
                <Icon size={14} className="text-[var(--text-muted)]" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                <ChevronRight size={13} className="text-[var(--text-muted)]" aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      )}
    </Dropdown>
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
    <label className="relative block m-1">
      <Search
        size={13}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
        aria-hidden="true"
      />
      <span className="sr-only">{placeholder}</span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] py-1.5 pl-8 pr-2 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
      />
    </label>
  );
}

function getOptions(
  category: TaskFilterBuilderCategory | null,
  sources: EnabledSource[],
  sourceLists: SourceList[],
  tags: TaskTag[],
  assignees: string[],
  projects: HubProject[]
): FilterOption[] {
  switch (category) {
    case 'priority':
      return [
        { value: '>=high', label: 'High or higher' },
        { value: '>=medium', label: 'Medium or higher' },
        { value: '<=medium', label: 'Medium or lower' },
        ...['critical', 'high', 'medium', 'low', 'none'].map((value) => ({
        value,
        label: value === 'none'
          ? 'No priority'
          : `${PRIORITY_LABELS[value] || ''} ${capitalize(value)}`.trim(),
        })),
      ];
    case 'status':
      return ['todo', 'in_progress', 'done', 'cancelled'].map((value) => ({
        value,
        label: STATUS_LABELS[value] || capitalize(value),
      }));
    case 'source':
      return uniqueOptions(
        sources
          .filter((source) => !source.notificationOnly)
          .map((source) => ({ value: source.type, label: source.name || source.type }))
      );
    case 'list':
      return withNoneOption(sourceLists.map((list) => ({
        value: list.name.toLowerCase(),
        label: list.name,
        detail: list.taskCount > 0 ? String(list.taskCount) : undefined,
      })), 'No list');
    case 'tag':
      return withNoneOption(tags.map((tag) => ({
        value: tag.slug.toLowerCase(),
        label: tag.name,
        detail: tag.count ? String(tag.count) : undefined,
      })), 'No tags');
    case 'assignee':
      return withNoneOption(assignees
        .map((assignee) => assignee.trim())
        .filter(Boolean)
        .map((assignee) => ({ value: assignee.toLowerCase(), label: assignee })), 'No assignee');
    case 'project':
      return withNoneOption(projects.map((project) => ({
        value: project.id,
        label: project.name,
      })), 'No project');
    case 'phase':
      return withNoneOption(projects.flatMap((project) =>
        (project.phases ?? []).map((phase) => ({
          value: phase.id,
          label: phase.name,
          detail: project.name,
        }))
      ), 'No phase');
    case 'due':
      return DUE_OPTIONS;
    default:
      return [];
  }
}

function uniqueOptions(options: FilterOption[]): FilterOption[] {
  return [...new Map(options.map((option) => [option.value, option])).values()]
    .sort((a, b) => a.label.localeCompare(b.label));
}

function withNoneOption(options: FilterOption[], label: string): FilterOption[] {
  return [{ value: 'none', label }, ...uniqueOptions(options).filter(({ value }) => value !== 'none')];
}

function capitalize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
