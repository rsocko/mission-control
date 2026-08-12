'use client';

import { useEffect, useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  taskFilterContextFromSavedView,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import { getLocalToday } from '@/lib/utils/client-date';
import {
  parseFilterQuery,
  type FilterToken,
  type FilterTokenType,
} from '@/lib/utils/parseFilterQuery';
import type {
  EnabledSource,
  HubProject,
  ListGroup,
  SavedView,
  SourceList,
  TaskTag,
} from '@/types/dashboard';
import { PRIORITY_LABELS, STATUS_LABELS } from '@/types/dashboard';

type ContextPatch = Partial<Omit<TaskFilterContext, 'version'>>;
type UpdateContext = (patch: ContextPatch, mode?: 'push' | 'replace') => void;

export interface UniverseFilterOptions {
  sources: EnabledSource[];
  sourceLists: Array<SourceList & { connectorType?: string }>;
  listGroups: ListGroup[];
  tags: TaskTag[];
  projects: HubProject[];
  assignees: string[];
  savedViews: SavedView[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

interface FilterSurfaceProps {
  context: TaskFilterContext;
  activeFilterCount: number;
  filteredTaskCount: number | null;
  update: UpdateContext;
  setContext: (context: TaskFilterContext, mode?: 'push' | 'replace') => void;
  clear: (mode?: 'push' | 'replace') => void;
  options: UniverseFilterOptions;
}

export function useUniverseFilterOptions(): UniverseFilterOptions {
  const [state, setState] = useState<Omit<UniverseFilterOptions, 'loading' | 'retry'>>({
    sources: [],
    sourceLists: [],
    listGroups: [],
    tags: [],
    projects: [],
    assignees: [],
    savedViews: [],
    error: null,
  });
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const urls = [
          '/api/features',
          '/api/connectors',
          '/api/list-groups',
          '/api/tags',
          '/api/hub-projects?includePhases=true',
          '/api/tasks/filter-options',
        ];
        const responses = await Promise.all(urls.map((url) => fetch(url, { signal: controller.signal })));
        const failed = responses.find((response) => !response.ok);
        if (failed) throw new Error(`Filter options failed to load (${failed.status})`);
        const [features, connectors, groups, tags, projects, filterOptions] =
          await Promise.all(responses.map((response) => response.json()));
        let savedViews: SavedView[] = [];
        try {
          const stored = localStorage.getItem('mission-control:saved-views');
          if (stored) savedViews = JSON.parse(stored) as SavedView[];
        } catch {
          savedViews = [];
        }
        const connectorTypeById = new Map<string, string>(
          (connectors.connectors ?? []).map((connector: { id: string; type: string }) => [
            connector.id,
            connector.type,
          ]),
        );
        setState({
          sources: features.enabledSources ?? [],
          sourceLists: (connectors.sourceLists ?? []).map((list: SourceList) => ({
            ...list,
            connectorType: connectorTypeById.get(list.connectorInstanceId),
          })),
          listGroups: (groups.groups ?? []).map((group: ListGroup) => group),
          tags: tags.tags ?? [],
          projects: projects.projects ?? [],
          assignees: filterOptions.assignees ?? [],
          savedViews,
          error: null,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : 'Filter options failed to load',
        }));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [reloadKey]);

  return {
    ...state,
    loading,
    retry: () => setReloadKey((value) => value + 1),
  };
}

export function UniverseFilterPanel({
  open,
  onClose,
  context,
  update,
  setContext,
  clear,
  activeFilterCount,
  filteredTaskCount,
  options,
}: FilterSurfaceProps & { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <aside
      aria-label="Task universe filters"
      className="absolute inset-y-0 left-0 z-30 flex w-[min(340px,92vw)] flex-col border-r border-[var(--border)] bg-[var(--surface-1)] shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-3">
        <SlidersHorizontal size={15} aria-hidden="true" />
        <h2 className="text-sm font-semibold">Task universe filters</h2>
        <span className="text-[10px] text-[var(--text-tertiary)]">{activeFilterCount} active</span>
        <button type="button" onClick={onClose} aria-label="Close task filters" className="ml-auto rounded p-1 hover:bg-[var(--surface-2)]">
          <X size={15} />
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {options.loading ? <p className="text-xs text-[var(--text-tertiary)]">Loading filter choices…</p> : null}
        {options.error ? <p role="alert" className="text-xs text-red-300">{options.error}</p> : null}
        {options.savedViews.length ? (
          <FilterSection label="Saved views">
            <div className="grid gap-1">
              {options.savedViews.map((view) => (
                <button
                  type="button"
                  key={view.id}
                  onClick={() => setContext(
                    view.filterContext ?? taskFilterContextFromSavedView(view.filters),
                    'push',
                  )}
                  className="rounded-md px-2 py-1.5 text-left text-xs hover:bg-[var(--surface-2)]"
                >
                  {view.name}
                </button>
              ))}
            </div>
          </FilterSection>
        ) : null}
        <FilterSection label="Sources">
          <ToggleGrid
            values={options.sources.filter((source) => !source.notificationOnly).map((source) => source.type)}
            selected={context.sources}
            label={(value) => options.sources.find((source) => source.type === value)?.name ?? value}
            onToggle={(value) => update(sourceSelectionPatch(context, options, value))}
          />
        </FilterSection>
        <FilterSection label="Project">
          <FilterSelect
            label="Project"
            value={context.projectId ?? ''}
            onChange={(value) => update({ projectId: value || null })}
            options={options.projects.map((project) => ({ value: project.id, label: project.name }))}
          />
        </FilterSection>
        <FilterSection label="Lists and groups">
          <FilterSelect
            label="List group"
            value={context.listGroupId ?? ''}
            onChange={(value) => update({ listGroupId: value || null })}
            options={options.listGroups.map((group) => ({ value: group.id, label: group.name }))}
          />
          <ToggleGrid
            values={options.sourceLists.map(exactListId)}
            selected={context.listIds}
            label={(value) => options.sourceLists.find((list) => exactListId(list) === value)?.name ?? value}
            onToggle={(value) => update({ listIds: toggle(context.listIds, value) })}
          />
        </FilterSection>
        <FilterSection label="Tags">
          <ToggleGrid
            values={[...new Set(options.tags.map((tag) => tag.slug))]}
            selected={context.tagSlugs}
            label={(value) => options.tags.find((tag) => tag.slug === value)?.name ?? value}
            onToggle={(value) => update({ tagSlugs: toggle(context.tagSlugs, value) })}
          />
        </FilterSection>
        <FilterSection label="Status and priority">
          <ToggleGrid
            values={Object.keys(STATUS_LABELS)}
            selected={context.statuses}
            label={(value) => STATUS_LABELS[value] ?? value}
            onToggle={(value) => update({ statuses: toggle(context.statuses, value) })}
          />
          <ToggleGrid
            values={Object.keys(PRIORITY_LABELS)}
            selected={context.priorities}
            label={(value) => PRIORITY_LABELS[value] === '—' ? 'None' : PRIORITY_LABELS[value] ?? value}
            onToggle={(value) => update({ priorities: toggle(context.priorities, value) })}
          />
        </FilterSection>
        <FilterSection label="Assignee">
          <ToggleGrid
            values={options.assignees}
            selected={parseFilterQuery(context.query).assigneeTokens}
            label={(value) => value}
            onToggle={(value) => update({ query: toggleQueryToken(context.query, 'assignee', value) })}
          />
        </FilterSection>
        <FilterSection label="Completion and dates">
          <button
            type="button"
            aria-pressed={context.completion === 'all'}
            onClick={() => update({ completion: context.completion === 'all' ? 'open' : 'all' })}
            className="flex w-full items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1.5 text-left text-xs"
          >
            <span className="flex h-4 w-4 items-center justify-center rounded border border-[var(--border)]">
              {context.completion === 'all' ? <Check size={11} /> : null}
            </span>
            Include completed tasks
          </button>
          <FilterSelect
            label="Date criteria"
            value={context.quickFilter ?? ''}
            onChange={(value) => update({
              quickFilter: value || null,
              myDayDate: value === 'myDay' ? getLocalToday() : null,
              ...(value === 'myDay' ? { completion: 'all' as const } : {}),
            })}
            options={[
              { value: 'myDay', label: 'My Day' },
              { value: 'overdue', label: 'Overdue' },
              { value: 'week', label: 'Due this week' },
              { value: 'recentlyCreated', label: 'Recently created' },
            ]}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberFilter
              label="Created at least (days)"
              value={context.ageMinDays}
              onChange={(value) => update({ ageMinDays: value })}
            />
            <NumberFilter
              label="Created within (days)"
              value={context.ageMaxDays}
              onChange={(value) => update({ ageMaxDays: value })}
            />
          </div>
        </FilterSection>
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--border)] p-3">
        <span className="text-xs text-[var(--text-tertiary)]">
          {filteredTaskCount === null ? 'Count pending' : `${filteredTaskCount} matching`}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => clear()} disabled={!activeFilterCount}>
          Clear all
        </Button>
      </div>
    </aside>
  );
}

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details open className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)]">
      <summary className="flex cursor-pointer list-none items-center gap-1 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        <ChevronDown size={11} aria-hidden="true" /> {label}
      </summary>
      <div className="space-y-2 border-t border-[var(--border)] p-2">{children}</div>
    </details>
  );
}

function ToggleGrid({
  values,
  selected,
  label,
  onToggle,
}: {
  values: string[];
  selected: string[];
  label: (value: string) => string;
  onToggle: (value: string) => void;
}) {
  if (!values.length) return <p className="text-[10px] text-[var(--text-tertiary)]">No choices available</p>;
  return (
    <div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto">
      {values.map((value) => {
        const active = selected.includes(value);
        return (
          <button
            type="button"
            key={value}
            aria-pressed={active}
            onClick={() => onToggle(value)}
            className={`rounded-md border px-2 py-1 text-[10px] ${
              active
                ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/15 text-[var(--accent-300)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
            }`}
          >
            {label(value)}
          </button>
        );
      })}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const ANY_VALUE = '__any__';
  return (
    <div className="block text-[10px] text-[var(--text-tertiary)]">
      <span>{label}</span>
      <Select
        value={value || ANY_VALUE}
        onValueChange={(next) => onChange(next === ANY_VALUE ? '' : next)}
      >
        <SelectTrigger
          aria-label={label}
          className="mt-1 h-8 min-h-8 w-full bg-[var(--surface-1)] px-2 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY_VALUE}>Any</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function NumberFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="text-[10px] text-[var(--text-tertiary)]">
      <CalendarDays size={11} className="mr-1 inline" aria-hidden="true" />
      {label}
      <input
        type="number"
        min={0}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
        className="mt-1 h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 text-xs"
      />
    </label>
  );
}

function toggle(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function sourceSelectionPatch(
  context: TaskFilterContext,
  options: UniverseFilterOptions,
  value: string,
): ContextPatch {
  const sources = toggle(context.sources, value);
  const listIds = context.listIds.filter((listId) => {
    const list = options.sourceLists.find((candidate) => exactListId(candidate) === listId);
    return !list?.connectorType || sources.includes(list.connectorType);
  });
  return {
    sources,
    listIds,
    ...(sources.length ? {} : { listGroupId: null }),
  };
}

function exactListId(list: SourceList): string {
  return `${list.connectorInstanceId}:${list.sourceId}`;
}

function toggleQueryToken(query: string, type: FilterTokenType, value: string): string {
  const tokens = parseFilterQuery(query).tokens;
  const index = tokens.findIndex((token) => token.type === type && token.value === value && !token.negated);
  const next = index >= 0
    ? tokens.filter((_, tokenIndex) => tokenIndex !== index)
    : [...tokens, { type, value, negated: false, raw: `${type}:${quoteValue(value)}` } as FilterToken];
  return next.map((token) => token.raw).join(' ');
}

function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
