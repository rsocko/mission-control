'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useMyDayQueries, myDayKeys } from '@/lib/hooks/useDashboardQueries';
import { uiLogger } from '@/lib/client-logger';
import {
  EMPTY_SUGGESTION_GROUPS,
  type CalendarEvent,
  type EnergyLevel,
  type MyDayItem,
  type ScheduledTask,
  type SourceList,
  type SuggestionGroups,
} from '@/components/today/types';

export function useMyDayData(todayISO: string) {
  const queryClient = useQueryClient();
  const queries = useMyDayQueries(todayISO);
  const [items, setItems] = useState<MyDayItem[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTask[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionGroups>(EMPTY_SUGGESTION_GROUPS);
  const [sourceLists, setSourceLists] = useState<SourceList[]>([]);
  const [energyLevel, setEnergyLevel] = useState<EnergyLevel | null>(null);
  const [loading, setLoading] = useState(true);

  // Sync React Query data into local state when it arrives
  useEffect(() => {
    if (queries.itemsQuery.data) {
      const myDayData = queries.itemsQuery.data;
      setItems((myDayData.items as MyDayItem[]) || []);
      const sugg = myDayData.suggestions as Record<string, unknown[]> | undefined;
      setSuggestions({
        planningSignals: (sugg?.planningSignals as MyDayItem[]) || [],
        planningNext: (sugg?.planningNext as MyDayItem[]) || [],
        yesterday: (sugg?.yesterday as MyDayItem[]) || [],
        overdue: (sugg?.overdue as MyDayItem[]) || [],
        dueToday: (sugg?.dueToday as MyDayItem[]) || [],
        dueThisWeek: (sugg?.dueThisWeek as MyDayItem[]) || [],
        highPriority: (sugg?.highPriority as MyDayItem[]) || [],
        aiRecommended: (sugg?.aiRecommended as MyDayItem[]) || [],
        recentlyAdded: (sugg?.recentlyAdded as MyDayItem[]) || [],
        carriedForward: (sugg?.carriedForward as MyDayItem[]) || [],
        repeatedlyRescheduled: (sugg?.repeatedlyRescheduled as MyDayItem[]) || [],
      });
      setLoading(false);
    }
  }, [queries.itemsQuery.data]);

  useEffect(() => {
    if (queries.scheduleQuery.data) {
      setScheduled(queries.scheduleQuery.data as ScheduledTask[]);
    }
  }, [queries.scheduleQuery.data]);

  useEffect(() => {
    if (queries.calendarQuery.data) {
      setCalendarEvents(queries.calendarQuery.data as CalendarEvent[]);
    }
  }, [queries.calendarQuery.data]);

  useEffect(() => {
    if (queries.connectorsQuery.data) {
      const data = queries.connectorsQuery.data;
      if (data.sourceLists) setSourceLists(data.sourceLists);
    }
  }, [queries.connectorsQuery.data]);

  useEffect(() => {
    if (queries.energyQuery.data !== undefined) {
      setEnergyLevel(queries.energyQuery.data as EnergyLevel | null);
    }
  }, [queries.energyQuery.data]);

  // fetchData triggers a sync + invalidates the React Query cache
  const fetchData = useCallback(async (options?: { skipSync?: boolean }) => {
    try {
      if (!options?.skipSync) {
        await fetch('/api/my-day/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: todayISO }),
        }).catch((err) => { uiLogger.error('Failed to sync My Day', { err }); });
      }
      // Invalidate all my day queries to refetch fresh data
      await queryClient.invalidateQueries({ queryKey: ['myDay'] });
    } catch (err) {
      uiLogger.error('Failed to fetch today data', { err });
    }
  }, [todayISO, queryClient]);

  return {
    items,
    scheduled,
    calendarEvents,
    suggestions,
    sourceLists,
    energyLevel,
    loading,
    fetchData,
    setItems,
    setEnergyLevel,
  };
}
