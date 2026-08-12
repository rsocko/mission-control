'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { uiLogger } from '@/lib/client-logger';
import type {
  TaskResponse,
  HubProject,
  EnabledSource,
  SourceList,
  ListGroup,
  SyncStatusEntry,
  TaskTag,
} from '@/types/dashboard';
import { EMPTY_TASK_RESPONSE } from '@/types/dashboard';

// ─── Fetcher helpers ────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
  return res.json();
}

// ─── Query keys ─────────────────────────────────────────────────────────────

export const dashboardKeys = {
  tasks: (params: string) => ['dashboard', 'tasks', params] as const,
  notifications: () => ['dashboard', 'notifications'] as const,
  projects: () => ['dashboard', 'projects'] as const,
  myDayIds: (date: string) => ['dashboard', 'myDayIds', date] as const,
  connectors: () => ['dashboard', 'connectors'] as const,
  features: () => ['dashboard', 'features'] as const,
  listGroups: () => ['dashboard', 'listGroups'] as const,
  sourceCounts: () => ['dashboard', 'sourceCounts'] as const,
  tags: (source: string | null, listId: string | null) => ['dashboard', 'tags', source, listId] as const,
};

export const myDayKeys = {
  items: (date: string) => ['myDay', 'items', date] as const,
  schedule: (date: string) => ['myDay', 'schedule', date] as const,
  calendar: (date: string) => ['myDay', 'calendar', date] as const,
  connectors: () => ['myDay', 'connectors'] as const,
  energy: (date: string) => ['myDay', 'energy', date] as const,
};

// ─── Dashboard Queries ──────────────────────────────────────────────────────

interface ConnectorsResponse {
  connectors: Array<{
    id: string;
    type: string;
    name: string;
    lastSyncedAt?: string | null;
    enabled: boolean;
    capabilities?: Record<string, boolean>;
  }>;
  sourceLists?: SourceList[];
}

export function useDashboardQueries(taskParams: string) {
  const queryClient = useQueryClient();
  const today = getClientToday();

  const tasksQuery = useQuery({
    queryKey: dashboardKeys.tasks(taskParams),
    queryFn: () => fetchJson<TaskResponse>(`/api/tasks?${taskParams}`),
    placeholderData: (prev) => prev, // Keep previous data while refetching (avoids flash)
  });

  const projectsQuery = useQuery({
    queryKey: dashboardKeys.projects(),
    queryFn: () => fetchJson<{ projects: HubProject[] }>('/api/hub-projects?includePhases=true').then(d => d.projects || []),
    staleTime: 60 * 1000, // projects rarely change
  });

  const myDayIdsQuery = useQuery({
    queryKey: dashboardKeys.myDayIds(today),
    queryFn: () =>
      fetchJson<{ items: Array<{ taskId: string }> }>(`/api/my-day?date=${today}`)
        .then(d => new Set((d.items || []).map(item => item.taskId))),
    staleTime: 60 * 1000,
  });

  const connectorsQuery = useQuery({
    queryKey: dashboardKeys.connectors(),
    queryFn: async () => {
      const data = await fetchJson<ConnectorsResponse>('/api/connectors');
      const connectors = data.connectors || [];
      const syncStatus: SyncStatusEntry[] = connectors.map(c => ({
        id: c.id,
        type: c.type,
        name: c.name,
        lastSyncedAt: c.lastSyncedAt || null,
        enabled: c.enabled,
      }));
      return { syncStatus, sourceLists: data.sourceLists || [] };
    },
    staleTime: 60 * 1000,
  });

  const featuresQuery = useQuery({
    queryKey: dashboardKeys.features(),
    queryFn: () => fetchJson<{ enabledSources?: EnabledSource[] }>('/api/features')
      .then(d => d.enabledSources || []),
    staleTime: 5 * 60 * 1000, // features rarely change
  });

  const listGroupsQuery = useQuery({
    queryKey: dashboardKeys.listGroups(),
    queryFn: () =>
      fetchJson<{ groups: Array<ListGroup & { sourceLists?: unknown[] }> }>('/api/list-groups')
        .then(d => (d.groups || []).map(g => ({
          id: g.id, name: g.name, icon: g.icon || null, iconColor: g.iconColor || null, sortOrder: g.sortOrder || 0, createdAt: g.createdAt,
        }))),
    staleTime: 60 * 1000,
  });

  const sourceCountsQuery = useQuery({
    queryKey: dashboardKeys.sourceCounts(),
    queryFn: () =>
      fetchJson<{ sourceCounts?: Record<string, number> }>('/api/tasks?parentOnly=true&openOnly=true&limit=1&countsOnly=true')
        .then(d => d.sourceCounts || {}),
    staleTime: 30 * 1000,
  });

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }, [queryClient]);

  const invalidateTasks = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['dashboard', 'tasks'] });
  }, [queryClient]);

  return {
    tasksQuery,
    projectsQuery,
    myDayIdsQuery,
    connectorsQuery,
    featuresQuery,
    listGroupsQuery,
    sourceCountsQuery,
    invalidateAll,
    invalidateTasks,
  };
}

// ─── Tags Query (depends on filter state) ───────────────────────────────────

export function useTagsQuery(
  sourceFilter: string | null,
  listFilter: string | null,
  enabledSources: EnabledSource[],
  sourceLists: SourceList[]
) {
  const selectedSource = enabledSources.find(s => s.type === sourceFilter);
  const isPerList = selectedSource?.tagScope === 'per-list';
  // Wait for enabledSources/sourceLists to load before querying so the
  // correct listId is sent to the API (prevents caching an unfiltered result).
  const ready = !sourceFilter || enabledSources.length > 0;
  const listReady = !listFilter || !isPerList || sourceLists.length > 0;

  return useQuery({
    queryKey: dashboardKeys.tags(sourceFilter, listFilter),
    queryFn: () => {
      const params = new URLSearchParams();
      if (sourceFilter) params.set('source', sourceFilter);
      if (isPerList && listFilter) {
        const selectedList = sourceLists.find(sl =>
          sl.sourceId === listFilter
          || `${sl.connectorInstanceId}:${sl.sourceId}` === listFilter
        );
        if (selectedList) params.set('listId', selectedList.sourceId);
      }
      const url = '/api/tags' + (params.toString() ? `?${params.toString()}` : '');
      return fetchJson<{ tags: TaskTag[] }>(url).then(d =>
        (d.tags || []).map((t: TaskTag & { usageCount?: number }) => ({
          ...t,
          source: t.source || null,
          sources: t.sources || [],
          color: t.color || null,
          count: t.usageCount ?? 0,
        }))
      );
    },
    enabled: ready && listReady,
    staleTime: 30 * 1000,
  });
}

// ─── My Day Queries ─────────────────────────────────────────────────────────

export function useMyDayQueries(todayISO: string) {
  const queryClient = useQueryClient();

  const itemsQuery = useQuery({
    queryKey: myDayKeys.items(todayISO),
    queryFn: () => fetchJson<{ items: unknown[]; suggestions: unknown }>(`/api/my-day?date=${todayISO}`),
    placeholderData: (prev) => prev,
  });

  const scheduleQuery = useQuery({
    queryKey: myDayKeys.schedule(todayISO),
    queryFn: () => fetchJson<{ scheduled: unknown[] }>(`/api/schedule?date=${todayISO}`).then(d => d.scheduled || []),
    placeholderData: (prev) => prev,
  });

  const calendarQuery = useQuery({
    queryKey: myDayKeys.calendar(todayISO),
    queryFn: () => fetchJson<{ events: unknown[] }>(`/api/calendar-events?date=${todayISO}`).then(d => d.events || []),
    placeholderData: (prev) => prev,
  });

  const connectorsQuery = useQuery({
    queryKey: myDayKeys.connectors(),
    queryFn: () => fetchJson<{ sourceLists?: SourceList[]; connectors?: Array<{ id: string; capabilities?: Record<string, boolean> }> }>('/api/connectors'),
    staleTime: 60 * 1000,
  });

  const energyQuery = useQuery({
    queryKey: myDayKeys.energy(todayISO),
    queryFn: () => fetchJson<{ checkin?: { level: string } }>(`/api/energy?date=${todayISO}`).then(d => d.checkin?.level || null),
    staleTime: 60 * 1000,
  });

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['myDay'] });
  }, [queryClient]);

  return {
    itemsQuery,
    scheduleQuery,
    calendarQuery,
    connectorsQuery,
    energyQuery,
    invalidateAll,
  };
}
